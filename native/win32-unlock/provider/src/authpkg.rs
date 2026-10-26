// Looks up the LSA authentication package ID for "Negotiate", needed to fill
// CREDENTIAL_PROVIDER_CREDENTIAL_SERIALIZATION::ulAuthenticationPackage.
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Security::Authentication::Identity::{
    LSA_STRING, LsaConnectUntrusted, LsaDeregisterLogonProcess, LsaLookupAuthenticationPackage,
};
use windows::core::PSTR;

pub fn negotiate_package_id() -> windows::core::Result<u32> {
    unsafe {
        let mut lsa_handle = HANDLE::default();
        let status = LsaConnectUntrusted(&mut lsa_handle);
        if status.0 != 0 {
            return Err(windows::core::Error::from_hresult(windows::core::HRESULT(status.0)));
        }

        let mut name = b"Negotiate\0".to_vec();
        let lsa_string = LSA_STRING {
            Length: 9,
            MaximumLength: 10,
            Buffer: PSTR(name.as_mut_ptr()),
        };

        let mut package_id: u32 = 0;
        let status = LsaLookupAuthenticationPackage(lsa_handle, &lsa_string, &mut package_id);
        let _ = LsaDeregisterLogonProcess(lsa_handle);

        if status.0 != 0 {
            return Err(windows::core::Error::from_hresult(windows::core::HRESULT(status.0)));
        }
        Ok(package_id)
    }
}
