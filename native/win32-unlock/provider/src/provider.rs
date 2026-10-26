use std::cell::RefCell;
use std::thread;

use windows::Win32::Foundation::{BOOL, CloseHandle, E_INVALIDARG, E_NOTIMPL, HANDLE};
use windows::Win32::System::Com::CoTaskMemAlloc;
use windows::Win32::System::Threading::SetEvent;
use windows::Win32::UI::Shell::{
    CPFT_LARGE_TEXT, CPFT_SUBMIT_BUTTON, CPUS_LOGON, CPUS_UNLOCK_WORKSTATION,
    CREDENTIAL_PROVIDER_CREDENTIAL_SERIALIZATION, CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR,
    CREDENTIAL_PROVIDER_USAGE_SCENARIO, ICredentialProvider_Impl, ICredentialProviderCredential,
    ICredentialProviderEvents,
};
use windows::core::{Error, GUID, PWSTR, implement};

use crate::credential::{Credential, FIELD_COUNT, FIELD_LARGE_TEXT, FIELD_SUBMIT_BUTTON};
use crate::log::logf;
use crate::signal::{create_stop_event, is_signal_fresh, wait_for_change_or_stop};

fn alloc_cotaskmem_wstr(s: &str) -> PWSTR {
    let wide: Vec<u16> = s.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let buf = CoTaskMemAlloc(wide.len() * 2) as *mut u16;
        if !buf.is_null() {
            std::ptr::copy_nonoverlapping(wide.as_ptr(), buf, wide.len());
        }
        PWSTR(buf)
    }
}

#[implement(windows::Win32::UI::Shell::ICredentialProvider)]
pub struct Provider {
    usage_scenario: RefCell<Option<CREDENTIAL_PROVIDER_USAGE_SCENARIO>>,
    // Wakes the watcher thread spawned in Advise immediately on UnAdvise/a new Advise, instead of it waking on
    // a timer to check a stop flag -- without some such signal, LogonUI never learns a signal arrived after it
    // already loaded the provider (confirmed: GetCredentialCount is only queried once at load, never polled).
    watcher_stop: RefCell<Option<HANDLE>>,
}

// A HANDLE is just an opaque, process-wide ID (not a pointer into this thread's own memory), so using the same
// value concurrently from two threads is fine -- windows-rs marks it !Send only because it can't know that.
struct SendHandle(HANDLE);
unsafe impl Send for SendHandle {}

impl Provider {
    pub fn new() -> Self {
        logf!("Provider::new");
        Self { usage_scenario: RefCell::new(None), watcher_stop: RefCell::new(None) }
    }

    fn stop_watcher(&self) {
        if let Some(stop) = self.watcher_stop.borrow_mut().take() {
            unsafe {
                let _ = SetEvent(stop); // wakes the watcher thread, which closes this handle itself
            }
        }
    }

    fn watch_for_signal(events: SendEvents, upadvisecontext: usize, stop: SendHandle) {
        let events = events.0;
        let stop = stop.0;
        let mut was_fresh = is_signal_fresh();
        loop {
            if !wait_for_change_or_stop(stop) {
                break; // stop requested, or the directory watch could not be set up
            }
            // A wake just means *something* changed in the directory (our own log.txt included) -- the file's
            // freshness is still the authoritative check, and the was_fresh transition keeps a burst of
            // incidental wakes (e.g. several log lines in a row) from notifying more than once per real signal.
            let fresh = is_signal_fresh();
            if fresh && !was_fresh {
                logf!("Provider::watch_for_signal: signal became fresh, notifying CredentialsChanged");
                if let Err(e) = unsafe { events.CredentialsChanged(upadvisecontext) } {
                    logf!("Provider::watch_for_signal: CredentialsChanged failed: {e:?}");
                }
            }
            was_fresh = fresh;
        }
        unsafe {
            let _ = CloseHandle(stop);
        }
        logf!("Provider::watch_for_signal: stopped");
    }
}

// LogonUI hosts credential providers in a multi-threaded COM apartment, so
// calling back into the events interface from our own worker thread is the
// documented pattern (hardware-arrival providers -- smart card, biometric --
// do the same). windows-rs marks the raw interface !Send by default since it
// can't know that; this wrapper asserts what the hosting model guarantees.
struct SendEvents(ICredentialProviderEvents);
unsafe impl Send for SendEvents {}

impl ICredentialProvider_Impl for Provider_Impl {
    fn SetUsageScenario(&self, cpus: CREDENTIAL_PROVIDER_USAGE_SCENARIO, _dwflags: u32) -> windows::core::Result<()> {
        logf!("Provider::SetUsageScenario: {}", cpus.0);
        if cpus == CPUS_UNLOCK_WORKSTATION || cpus == CPUS_LOGON {
            // On this build, LogonUI queries third-party providers under
            // CPUS_LOGON even for the plain, single-user lock screen (empirically
            // confirmed: CPUS_UNLOCK_WORKSTATION is never sent here). Safe to accept
            // both now that visibility is gated by signal freshness, not by scenario.
            *self.usage_scenario.borrow_mut() = Some(cpus);
            Ok(())
        } else {
            Err(Error::from(E_NOTIMPL))
        }
    }

    fn SetSerialization(&self, _pcpcs: *const CREDENTIAL_PROVIDER_CREDENTIAL_SERIALIZATION) -> windows::core::Result<()> {
        logf!("Provider::SetSerialization (unused in this spike)");
        Err(Error::from(E_NOTIMPL))
    }

    fn Advise(&self, pcpe: Option<&ICredentialProviderEvents>, upadvisecontext: usize) -> windows::core::Result<()> {
        logf!("Provider::Advise");
        self.stop_watcher();
        if let Some(events) = pcpe {
            let Some(stop) = create_stop_event() else {
                logf!("Provider::Advise: could not create the stop event, no watcher thread");
                return Ok(());
            };
            let events = SendEvents(events.clone());
            let stop_for_thread = SendHandle(stop);
            *self.watcher_stop.borrow_mut() = Some(stop);
            thread::spawn(move || Provider::watch_for_signal(events, upadvisecontext, stop_for_thread));
        }
        Ok(())
    }

    fn UnAdvise(&self) -> windows::core::Result<()> {
        logf!("Provider::UnAdvise");
        self.stop_watcher();
        Ok(())
    }

    fn GetFieldDescriptorCount(&self) -> windows::core::Result<u32> {
        Ok(FIELD_COUNT)
    }

    fn GetFieldDescriptorAt(&self, dwindex: u32) -> windows::core::Result<*mut CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR> {
        let (cpft, label) = match dwindex {
            FIELD_LARGE_TEXT => (CPFT_LARGE_TEXT, "ispyx"),
            FIELD_SUBMIT_BUTTON => (CPFT_SUBMIT_BUTTON, "Submit"),
            _ => return Err(Error::from(E_INVALIDARG)),
        };
        unsafe {
            let mem = CoTaskMemAlloc(std::mem::size_of::<CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR>())
                as *mut CREDENTIAL_PROVIDER_FIELD_DESCRIPTOR;
            if mem.is_null() {
                return Err(Error::from(windows::Win32::Foundation::E_OUTOFMEMORY));
            }
            (*mem).dwFieldID = dwindex;
            (*mem).cpft = cpft;
            (*mem).pszLabel = alloc_cotaskmem_wstr(label);
            (*mem).guidFieldType = GUID::zeroed();
            Ok(mem)
        }
    }

    fn GetCredentialCount(
        &self,
        pdwcount: *mut u32,
        pdwdefault: *mut u32,
        pbautologonwithdefault: *mut BOOL,
    ) -> windows::core::Result<()> {
        // No tile at all unless a fresh signal is present -- nothing for a
        // bystander to click, ever, under normal circumstances.
        let fresh = is_signal_fresh();
        logf!("Provider::GetCredentialCount: signal_fresh={fresh}");
        unsafe {
            if fresh {
                *pdwcount = 1;
                *pdwdefault = 0;
                *pbautologonwithdefault = BOOL(1);
            } else {
                *pdwcount = 0;
                *pdwdefault = u32::MAX; // CREDENTIAL_PROVIDER_NO_DEFAULT
                *pbautologonwithdefault = BOOL(0);
            }
        }
        Ok(())
    }

    fn GetCredentialAt(&self, dwindex: u32) -> windows::core::Result<ICredentialProviderCredential> {
        if dwindex != 0 || !is_signal_fresh() {
            return Err(Error::from(E_INVALIDARG));
        }
        let scenario = self.usage_scenario.borrow().unwrap_or(CPUS_UNLOCK_WORKSTATION);
        logf!("Provider::GetCredentialAt(0), scenario={}", scenario.0);
        Ok(Credential::new(scenario).into())
    }
}
