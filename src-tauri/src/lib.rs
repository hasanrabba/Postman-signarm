mod proxy;
mod mock_server;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Intentionally no plugins: we don't want the UI to have access to the
    // filesystem, shell, dialog, notifications, or opener. Everything the
    // app needs goes through our own IPC commands (proxy_fetch,
    // mock_register, mock_base_url) which validate their inputs.
    tauri::Builder::default()
        .setup(|app| {
            // Kick off the local mock HTTP server on a free port; the UI
            // discovers the port via a Tauri command.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                mock_server::start(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            proxy::proxy_fetch,
            mock_server::mock_register,
            mock_server::mock_base_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
