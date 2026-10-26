use std::cell::RefCell;

use windows::Win32::Foundation::{BOOL, E_INVALIDARG, E_NOTIMPL, NTSTATUS};
use windows::Win32::Graphics::Gdi::HBITMAP;
use windows::Win32::System::Com::CoTaskMemAlloc;
use windows::Win32::Security::Authentication::Identity::{KerbInteractiveLogon, KerbWorkstationUnlockLogon};
use windows::Win32::UI::Shell::{
    CPFIS_NONE, CPFS_DISPLAY_IN_BOTH, CPGSR_RETURN_CREDENTIAL_FINISHED, CPUS_UNLOCK_WORKSTATION,
    CREDENTIAL_PROVIDER_CREDENTIAL_SERIALIZATION, CREDENTIAL_PROVIDER_FIELD_INTERACTIVE_STATE,
    CREDENTIAL_PROVIDER_FIELD_STATE, CREDENTIAL_PROVIDER_GET_SERIALIZATION_RESPONSE,
    CREDENTIAL_PROVIDER_STATUS_ICON, CREDENTIAL_PROVIDER_USAGE_SCENARIO, ICredentialProviderCredential_Impl,
    ICredentialProviderCredentialEvents,
};
use windows::core::{Error, HRESULT, PCWSTR, PWSTR, implement};

use crate::authpkg::negotiate_package_id;
use crate::dpapi::unprotect_local_machine;
use crate::log::logf;
use crate::pack::pack_kerb_interactive_unlock_logon;
use crate::signal::{consume_signal, is_signal_fresh};

pub const FIELD_LARGE_TEXT: u32 = 0;
pub const FIELD_SUBMIT_BUTTON: u32 = 1;
pub const FIELD_COUNT: u32 = 2;

// Written by the panel's elevated setup step: a DPAPI blob (CRYPTPROTECT_LOCAL_MACHINE)
// wrapping three length-prefixed UTF-8 fields (domain, username, password), each as a
// u32 LE byte length followed by its bytes. The file's ACL (Administrators/SYSTEM only)
// is the real access control, not the DPAPI scope -- see dpapi.rs.
const SECRET_PATH: &str = r"C:\ProgramData\ispyx\unlock.secret";

fn local_computer_name() -> String {
    unsafe {
        let mut buf = [0u16; 256];
        let mut len = buf.len() as u32;
        if windows::Win32::System::WindowsProgramming::GetComputerNameW(PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::new()
        }
    }
}

/// Reads one u32-length-prefixed UTF-8 field, advancing `pos`. None on any malformed input.
fn read_field(bytes: &[u8], pos: &mut usize) -> Option<String> {
    if bytes.len() < *pos + 4 {
        return None;
    }
    let len = u32::from_le_bytes(bytes[*pos..*pos + 4].try_into().ok()?) as usize;
    *pos += 4;
    if bytes.len() < *pos + len {
        return None;
    }
    let s = String::from_utf8(bytes[*pos..*pos + len].to_vec()).ok()?;
    *pos += len;
    Some(s)
}

fn read_secret_credential() -> Option<(String, String, String)> {
    let blob = std::fs::read(SECRET_PATH).ok()?;
    let plain = match unprotect_local_machine(&blob) {
        Ok(p) => p,
        Err(e) => {
            logf!("Credential::read_secret_credential: DPAPI unprotect failed: {e:?}");
            return None;
        }
    };
    let mut pos = 0;
    let mut domain = read_field(&plain, &mut pos)?;
    let username = read_field(&plain, &mut pos)?;
    let password = read_field(&plain, &mut pos)?;
    if username.is_empty() || password.is_empty() {
        return None;
    }
    // A local account's domain is the machine's own NetBIOS name, not blank
    // -- empty LogonDomainName is what the MS sample's own helpers avoid.
    if domain.is_empty() {
        domain = local_computer_name();
    }
    Some((domain, username, password))
}

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

#[implement(windows::Win32::UI::Shell::ICredentialProviderCredential)]
pub struct Credential {
    events: RefCell<Option<ICredentialProviderCredentialEvents>>,
    scenario: CREDENTIAL_PROVIDER_USAGE_SCENARIO,
}

impl Credential {
    pub fn new(scenario: CREDENTIAL_PROVIDER_USAGE_SCENARIO) -> Self {
        logf!("Credential::new, scenario={}", scenario.0);
        Self { events: RefCell::new(None), scenario }
    }
}

impl ICredentialProviderCredential_Impl for Credential_Impl {
    fn Advise(&self, pcpce: Option<&ICredentialProviderCredentialEvents>) -> windows::core::Result<()> {
        logf!("Credential::Advise");
        *self.events.borrow_mut() = pcpce.cloned();
        Ok(())
    }

    fn UnAdvise(&self) -> windows::core::Result<()> {
        logf!("Credential::UnAdvise");
        *self.events.borrow_mut() = None;
        Ok(())
    }

    fn SetSelected(&self) -> windows::core::Result<BOOL> {
        // Safe to auto-submit now: this tile only exists for the ~20s the
        // signal file is fresh (see provider.rs GetCredentialCount), so
        // there's nothing for a bystander to click outside that window.
        let fresh = is_signal_fresh();
        logf!("Credential::SetSelected: signal_fresh={fresh}");
        Ok(BOOL(fresh as i32))
    }

    fn SetDeselected(&self) -> windows::core::Result<()> {
        logf!("Credential::SetDeselected");
        Ok(())
    }

    fn GetFieldState(
        &self,
        dwfieldid: u32,
        pcpfs: *mut CREDENTIAL_PROVIDER_FIELD_STATE,
        pcpfis: *mut CREDENTIAL_PROVIDER_FIELD_INTERACTIVE_STATE,
    ) -> windows::core::Result<()> {
        if dwfieldid >= FIELD_COUNT {
            return Err(Error::from(E_INVALIDARG));
        }
        unsafe {
            *pcpfs = CPFS_DISPLAY_IN_BOTH;
            *pcpfis = CPFIS_NONE;
        }
        Ok(())
    }

    fn GetStringValue(&self, dwfieldid: u32) -> windows::core::Result<PWSTR> {
        match dwfieldid {
            FIELD_LARGE_TEXT => Ok(alloc_cotaskmem_wstr("Unlock with ispyx")),
            _ => Err(Error::from(E_NOTIMPL)),
        }
    }

    fn GetBitmapValue(&self, _dwfieldid: u32) -> windows::core::Result<HBITMAP> {
        Err(Error::from(E_NOTIMPL))
    }

    fn GetCheckboxValue(&self, _dwfieldid: u32, _pbchecked: *mut BOOL, _ppszlabel: *mut PWSTR) -> windows::core::Result<()> {
        Err(Error::from(E_NOTIMPL))
    }

    fn GetSubmitButtonValue(&self, dwfieldid: u32) -> windows::core::Result<u32> {
        if dwfieldid == FIELD_SUBMIT_BUTTON {
            Ok(FIELD_LARGE_TEXT)
        } else {
            Err(Error::from(E_INVALIDARG))
        }
    }

    fn GetComboBoxValueCount(&self, _dwfieldid: u32, _pcitems: *mut u32, _pdwselecteditem: *mut u32) -> windows::core::Result<()> {
        Err(Error::from(E_NOTIMPL))
    }

    fn GetComboBoxValueAt(&self, _dwfieldid: u32, _dwitem: u32) -> windows::core::Result<PWSTR> {
        Err(Error::from(E_NOTIMPL))
    }

    fn SetStringValue(&self, _dwfieldid: u32, _psz: &PCWSTR) -> windows::core::Result<()> {
        Err(Error::from(E_NOTIMPL))
    }

    fn SetCheckboxValue(&self, _dwfieldid: u32, _bchecked: BOOL) -> windows::core::Result<()> {
        Err(Error::from(E_NOTIMPL))
    }

    fn SetComboBoxSelectedValue(&self, _dwfieldid: u32, _dwselecteditem: u32) -> windows::core::Result<()> {
        Err(Error::from(E_NOTIMPL))
    }

    fn CommandLinkClicked(&self, _dwfieldid: u32) -> windows::core::Result<()> {
        Err(Error::from(E_NOTIMPL))
    }

    fn GetSerialization(
        &self,
        pcpgsr: *mut CREDENTIAL_PROVIDER_GET_SERIALIZATION_RESPONSE,
        pcpcs: *mut CREDENTIAL_PROVIDER_CREDENTIAL_SERIALIZATION,
        _ppszoptionalstatustext: *mut PWSTR,
        _pcpsioptionalstatusicon: *mut CREDENTIAL_PROVIDER_STATUS_ICON,
    ) -> windows::core::Result<()> {
        if !is_signal_fresh() {
            logf!("Credential::GetSerialization: signal stale/missing, refusing");
            return Err(Error::from(E_NOTIMPL));
        }
        // Consume before attempting: whatever happens next (success, bad
        // credential, pack failure), this signal may never trigger a second
        // automatic submission. One try, then the tile is gone and the user
        // has the lock screen back to themselves.
        consume_signal();
        let Some((domain, username, password)) = read_secret_credential() else {
            logf!("Credential::GetSerialization: no/empty/unreadable secret at {SECRET_PATH}");
            return Err(Error::from(E_NOTIMPL));
        };
        let message_type = if self.scenario == CPUS_UNLOCK_WORKSTATION {
            KerbWorkstationUnlockLogon
        } else {
            KerbInteractiveLogon
        };
        logf!(
            "Credential::GetSerialization: packing credential for domain={domain:?} user={username} pwlen={}, message_type={}",
            password.len(),
            message_type.0
        );
        let packed = match unsafe { pack_kerb_interactive_unlock_logon(message_type, &domain, &username, &password) } {
            Ok(p) => p,
            Err(e) => {
                logf!("Credential::GetSerialization: pack failed: {e:?}");
                return Err(e);
            }
        };

        let auth_package = match negotiate_package_id() {
            Ok(id) => id,
            Err(e) => {
                logf!("Credential::GetSerialization: auth package lookup failed: {e:?}");
                return Err(e);
            }
        };

        unsafe {
            (*pcpcs).ulAuthenticationPackage = auth_package;
            (*pcpcs).clsidCredentialProvider = crate::CLSID_PROVIDER;
            (*pcpcs).cbSerialization = packed.size;
            (*pcpcs).rgbSerialization = packed.buffer;
            *pcpgsr = CPGSR_RETURN_CREDENTIAL_FINISHED;
        }
        logf!("Credential::GetSerialization: ok, auth_package={auth_package}");
        Ok(())
    }

    fn ReportResult(
        &self,
        ntsstatus: NTSTATUS,
        ntssubstatus: NTSTATUS,
        _ppszoptionalstatustext: *mut PWSTR,
        _pcpsioptionalstatusicon: *mut CREDENTIAL_PROVIDER_STATUS_ICON,
    ) -> windows::core::Result<()> {
        logf!("Credential::ReportResult: status={:#x} substatus={:#x}", ntsstatus.0, ntssubstatus.0);
        Ok(())
    }
}

// Silence an unused-import warning when E_NOTIMPL / HRESULT paths change shape.
#[allow(dead_code)]
fn _touch(_: HRESULT) {}
