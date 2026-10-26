use windows::Win32::Foundation::{BOOL, CLASS_E_NOAGGREGATION};
use windows::Win32::System::Com::IClassFactory_Impl;
use windows::core::{Error, GUID, IUnknown, Interface, implement};

use crate::log::logf;
use crate::provider::Provider;

#[implement(windows::Win32::System::Com::IClassFactory)]
pub struct ClassFactory;

impl IClassFactory_Impl for ClassFactory_Impl {
    fn CreateInstance(
        &self,
        punkouter: Option<&IUnknown>,
        riid: *const GUID,
        ppvobject: *mut *mut core::ffi::c_void,
    ) -> windows::core::Result<()> {
        if punkouter.is_some() {
            return Err(Error::from(CLASS_E_NOAGGREGATION));
        }
        logf!("ClassFactory::CreateInstance");
        let unknown: IUnknown = Provider::new().into();
        unsafe { unknown.query(riid, ppvobject).ok() }
    }

    fn LockServer(&self, _flock: BOOL) -> windows::core::Result<()> {
        Ok(())
    }
}
