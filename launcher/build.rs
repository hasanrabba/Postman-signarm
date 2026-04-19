// Embed the Windows icon resource so the launcher exe (and by extension
// the taskbar, Alt-Tab switcher, and Start-menu shortcut) shows a real
// icon instead of a default placeholder. On non-Windows targets
// embed_resource is a no-op.
fn main() {
    println!("cargo:rerun-if-changed=launcher.rc");
    println!("cargo:rerun-if-changed=icon.ico");
    let _ = embed_resource::compile("launcher.rc", embed_resource::NONE);
}
