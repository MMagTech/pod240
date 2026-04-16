//! Avoid extra console windows when a Windows GUI app spawns CLI tools (HandBrake, FFmpeg, etc.).

use std::process::Command;

/// Windows: `CREATE_NO_WINDOW` so child processes do not allocate a visible console.
pub(crate) fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}
