//! Windows-only integration for explicit clipboard copy and privacy Settings.

#[cfg(windows)]
pub fn open_microphone_settings() -> anyhow::Result<()> {
  use windows_sys::Win32::UI::Shell::ShellExecuteW;
  use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

  let operation: Vec<u16> = "open\0".encode_utf16().collect();
  let uri: Vec<u16> = "ms-settings:privacy-microphone\0".encode_utf16().collect();
  // Launch the registered Settings URI directly, without a console subprocess.
  // Both UTF-16 buffers remain alive and NUL-terminated throughout the call.
  let result = unsafe {
    ShellExecuteW(
      std::ptr::null_mut(),
      operation.as_ptr(),
      uri.as_ptr(),
      std::ptr::null(),
      std::ptr::null(),
      SW_SHOWNORMAL,
    )
  };
  settings_launch_result(result as isize).map_err(anyhow::Error::msg)
}

fn settings_launch_result(code: isize) -> Result<(), String> {
  // ShellExecuteW returns a compatibility code, not a real HINSTANCE.
  if code > 32 {
    Ok(())
  } else {
    Err(format!("Failed to open microphone Settings (Windows shell code {code})"))
  }
}

#[cfg(windows)]
pub fn copy_to_clipboard(text: &str) -> anyhow::Result<()> {
  use anyhow::Context;
  let mut clipboard = arboard::Clipboard::new().context("Failed to open Windows clipboard")?;
  clipboard.set_text(text).context("Failed to write text to Windows clipboard")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn settings_launch_rejects_shell_failure_codes() {
    for code in [0, 2, 3, 5, 8, 26, 27, 28, 29, 30, 31, 32] {
      let error = settings_launch_result(code).unwrap_err();
      assert!(error.contains(&code.to_string()));
    }
  }

  #[test]
  fn settings_launch_accepts_only_codes_above_32() {
    assert!(settings_launch_result(33).is_ok());
    assert!(settings_launch_result(42).is_ok());
  }

  #[cfg(windows)]
  #[test]
  #[ignore = "Requires an interactive Windows desktop and replaces clipboard contents"]
  fn explicit_clipboard_copy_round_trips_unicode() {
    let text = "SayType 中文 🎙️\nSecond line";
    copy_to_clipboard(text).unwrap();
    assert_eq!(arboard::Clipboard::new().unwrap().get_text().unwrap(), text);
  }
}
