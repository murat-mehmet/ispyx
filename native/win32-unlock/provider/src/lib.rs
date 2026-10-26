mod authpkg;
mod classfactory;
mod credential;
mod dpapi;
mod log;
mod pack;
mod provider;
mod reg;
mod signal;

use windows::Win32::Foundation::{CLASS_E_CLASSNOTAVAILABLE, E_NOINTERFACE, S_FALSE};
use windows::core::{GUID, HRESULT, IUnknown, Interface};

use crate::classfactory::ClassFactory;
use crate::log::logf;

pub const CLSID_PROVIDER: GUID = GUID::from_u128(0x1aa7e1e6_21de_4ad5_ae6e_454401b4b427);
pub const CLSID_PROVIDER_STR: &str = "1aa7e1e6-21de-4ad5-ae6e-454401b4b427";

#[unsafe(no_mangle)]
unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut core::ffi::c_void,
) -> HRESULT {
    logf!("DllGetClassObject called");
    unsafe {
        if ppv.is_null() {
            return E_NOINTERFACE;
        }
        *ppv = core::ptr::null_mut();
        if rclsid.is_null() || *rclsid != CLSID_PROVIDER {
            return CLASS_E_CLASSNOTAVAILABLE;
        }
        let unknown: IUnknown = ClassFactory.into();
        unknown.query(riid, ppv)
    }
}

#[unsafe(no_mangle)]
unsafe extern "system" fn DllCanUnloadNow() -> HRESULT {
    // Never report unloadable: LogonUI loads this fresh every lock cycle
    // anyway, no benefit to shrinking its working set here.
    S_FALSE
}

#[unsafe(no_mangle)]
unsafe extern "system" fn DllRegisterServer() -> HRESULT {
    match reg::register() {
        Ok(()) => HRESULT(0),
        Err(e) => e.code(),
    }
}

#[unsafe(no_mangle)]
unsafe extern "system" fn DllUnregisterServer() -> HRESULT {
    match reg::unregister() {
        Ok(()) => HRESULT(0),
        Err(e) => e.code(),
    }
}
