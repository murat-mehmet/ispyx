// Port of the `KerbInteractiveUnlockLogonPack` helper from Microsoft's
// CredentialProvider sample (Samples/CredentialProvider/cpp/helpers.cpp in
// microsoft/windows-classic-samples). Builds a single contiguous
// KERB_INTERACTIVE_UNLOCK_LOGON blob where each UNICODE_STRING.Buffer is
// replaced with a byte offset from the start of the blob (not a real
// pointer) -- required because this blob crosses into LSA's address space.
use std::mem::size_of;
use windows::Win32::Foundation::LUID;
use windows::Win32::Security::Authentication::Identity::{
    KERB_INTERACTIVE_UNLOCK_LOGON, KERB_LOGON_SUBMIT_TYPE, LSA_UNICODE_STRING,
};
use windows::Win32::System::Com::CoTaskMemAlloc;
use windows::core::{Error, HRESULT, PWSTR};

pub struct PackedLogon {
    pub buffer: *mut u8,
    pub size: u32,
}

pub unsafe fn pack_kerb_interactive_unlock_logon(
    message_type: KERB_LOGON_SUBMIT_TYPE,
    domain: &str,
    username: &str,
    password: &str,
) -> windows::core::Result<PackedLogon> {
    let domain_w: Vec<u16> = domain.encode_utf16().collect();
    let username_w: Vec<u16> = username.encode_utf16().collect();
    let password_w: Vec<u16> = password.encode_utf16().collect();

    let domain_bytes = (domain_w.len() * 2) as u32;
    let username_bytes = (username_w.len() * 2) as u32;
    let password_bytes = (password_w.len() * 2) as u32;

    let struct_size = size_of::<KERB_INTERACTIVE_UNLOCK_LOGON>() as u32;
    let total_size = struct_size + domain_bytes + username_bytes + password_bytes;

    let raw = unsafe { CoTaskMemAlloc(total_size as usize) };
    if raw.is_null() {
        return Err(Error::from(HRESULT(-2147024882i32))); // E_OUTOFMEMORY
    }
    let buffer = raw as *mut u8;
    unsafe { std::ptr::write_bytes(buffer, 0, total_size as usize) };

    let kiul = buffer as *mut KERB_INTERACTIVE_UNLOCK_LOGON;
    unsafe {
        (*kiul).Logon.MessageType = message_type;
        (*kiul).LogonId = LUID::default();
    }

    let mut offset = struct_size;
    unsafe {
        write_field(buffer, &mut (*kiul).Logon.LogonDomainName, &domain_w, &mut offset);
        write_field(buffer, &mut (*kiul).Logon.UserName, &username_w, &mut offset);
        write_field(buffer, &mut (*kiul).Logon.Password, &password_w, &mut offset);
    }

    Ok(PackedLogon { buffer, size: total_size })
}

unsafe fn write_field(
    base: *mut u8,
    field: &mut LSA_UNICODE_STRING,
    data: &[u16],
    offset: &mut u32,
) {
    let bytes = (data.len() * 2) as u16;
    field.Length = bytes;
    field.MaximumLength = bytes;
    if !data.is_empty() {
        unsafe {
            std::ptr::copy_nonoverlapping(data.as_ptr(), base.add(*offset as usize) as *mut u16, data.len());
        }
    }
    // Buffer holds a byte OFFSET from `base`, not a dereferenceable pointer --
    // LSA rebases it once the blob lands in its own address space.
    field.Buffer = PWSTR(*offset as isize as *mut u16);
    *offset += bytes as u32;
}
