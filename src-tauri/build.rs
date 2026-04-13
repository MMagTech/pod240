fn main() {
    // Force the Windows .rc / embedded icon to refresh when assets change. Without this, Cargo
    // incremental builds can skip re-linking and the exe keeps an old taskbar/title-bar icon.
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=pod240-icon-1024.png");

    tauri_build::build();
}
