// DPAPI unwrap for the secret blob written during setup (Node/PowerShell
// side, CRYPTPROTECT_LOCAL_MACHINE). Any local account can decrypt this
// scope by design -- the real access control is the file's ACL, set when
// the secret is written (Administrators/SYSTEM only, no interactive users).
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData};
use windows::core::Result;

pub fn unprotect_local_machine(blob: &[u8]) -> Result<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB { cbData: blob.len() as u32, pbData: blob.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)?;
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(HLOCAL(output.pbData as *mut _));
        Ok(out)
    }
}
