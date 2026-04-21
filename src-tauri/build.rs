fn main() {
  // The legacy objc macros still reference this feature gate on newer rustc.
  println!("cargo:rustc-check-cfg=cfg(feature, values(\"cargo-clippy\"))");
  tauri_build::build()
}
