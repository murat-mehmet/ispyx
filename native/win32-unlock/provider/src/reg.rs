use windows::Win32::Foundation::{ERROR_SUCCESS, HMODULE};
use windows::Win32::System::LibraryLoader::{
    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GetModuleFileNameW, GetModuleHandleExW,
};
use windows::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RegCloseKey,
    RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW,
};
use windows::core::{PCWSTR, Result, w};

use crate::CLSID_PROVIDER_STR;
use crate::log::logf;

const PROVIDER_NAME: PCWSTR = w!("ispyx unlock");

fn clsid_key_path() -> Vec<u16> {
    wide(&format!(r"SOFTWARE\Classes\CLSID\{{{CLSID_PROVIDER_STR}}}"))
}
fn inproc_key_path() -> Vec<u16> {
    wide(&format!(r"SOFTWARE\Classes\CLSID\{{{CLSID_PROVIDER_STR}}}\InprocServer32"))
}
fn provider_key_path() -> Vec<u16> {
    wide(&format!(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers\{{{CLSID_PROVIDER_STR}}}"
    ))
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn module_path() -> Result<Vec<u16>> {
    unsafe {
        let mut hmodule = HMODULE::default();
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
            PCWSTR(module_path as *const () as *const u16),
            &mut hmodule,
        )?;
        let mut buf = vec![0u16; 1024];
        let len = GetModuleFileNameW(hmodule, &mut buf);
        buf.truncate(len as usize);
        buf.push(0);
        Ok(buf)
    }
}

fn set_default_sz(key: HKEY, value: &[u16]) -> Result<()> {
    unsafe {
        let bytes = std::slice::from_raw_parts(value.as_ptr() as *const u8, value.len() * 2);
        RegSetValueExW(key, PCWSTR::null(), 0, REG_SZ, Some(bytes)).ok()?;
    }
    Ok(())
}

fn set_named_sz(key: HKEY, name: PCWSTR, value: &[u16]) -> Result<()> {
    unsafe {
        let bytes = std::slice::from_raw_parts(value.as_ptr() as *const u8, value.len() * 2);
        RegSetValueExW(key, name, 0, REG_SZ, Some(bytes)).ok()?;
    }
    Ok(())
}

fn create_key(path: &[u16]) -> Result<HKEY> {
    unsafe {
        let mut key = HKEY::default();
        RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(path.as_ptr()),
            0,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut key,
            None,
        )
        .ok()?;
        Ok(key)
    }
}

pub fn register() -> Result<()> {
    let dll_path = module_path()?;
    logf!("register: dll path = {}", String::from_utf16_lossy(&dll_path));

    unsafe {
        let clsid_key = create_key(&clsid_key_path())?;
        set_default_sz(clsid_key, wide("ispyx unlock").as_slice())?;
        let _ = RegCloseKey(clsid_key);

        let inproc_key = create_key(&inproc_key_path())?;
        set_default_sz(inproc_key, &dll_path)?;
        set_named_sz(inproc_key, w!("ThreadingModel"), wide("Apartment").as_slice())?;
        let _ = RegCloseKey(inproc_key);

        let provider_key = create_key(&provider_key_path())?;
        set_default_sz(provider_key, wide("ispyx unlock").as_slice())?;
        let _ = RegCloseKey(provider_key);
    }

    let _ = PROVIDER_NAME; // keep for future field descriptor reuse
    logf!("register: ok");
    Ok(())
}

pub fn unregister() -> Result<()> {
    unsafe {
        let clsid_parent = wide(r"SOFTWARE\Classes\CLSID");
        let clsid_name = wide(&format!("{{{CLSID_PROVIDER_STR}}}"));
        let mut parent = HKEY::default();
        if RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(clsid_parent.as_ptr()),
            0,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut parent,
            None,
        )
        .is_ok()
        {
            let _ = RegDeleteTreeW(parent, PCWSTR(clsid_name.as_ptr()));
            let _ = RegCloseKey(parent);
        }

        let providers_parent = wide(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\Credential Providers");
        let mut parent2 = HKEY::default();
        if RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(providers_parent.as_ptr()),
            0,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut parent2,
            None,
        )
        .is_ok()
        {
            let _ = RegDeleteTreeW(parent2, PCWSTR(clsid_name.as_ptr()));
            let _ = RegCloseKey(parent2);
        }
    }
    logf!("unregister: ok");
    let _ = ERROR_SUCCESS;
    Ok(())
}
