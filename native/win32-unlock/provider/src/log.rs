// Logging to a file because LogonUI has no attached console and crashes here
// are otherwise invisible.
use std::fs::OpenOptions;
use std::io::Write;

const LOG_DIR: &str = r"C:\ProgramData\ispyx";
const LOG_PATH: &str = r"C:\ProgramData\ispyx\unlock.log";

pub fn log(msg: &str) {
    let _ = std::fs::create_dir_all(LOG_DIR);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(LOG_PATH) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let _ = writeln!(f, "[{now}] [pid {}] {msg}", std::process::id());
    }
}

macro_rules! logf {
    ($($arg:tt)*) => {
        $crate::log::log(&format!($($arg)*))
    };
}
pub(crate) use logf;
