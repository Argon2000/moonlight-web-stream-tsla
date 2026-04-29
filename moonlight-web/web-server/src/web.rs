use actix_files::Files;
use actix_web::{HttpResponse, dev::HttpServiceFactory, get, services, web::Data};
use common::{api_bindings::ConfigJs, config::Config};
use log::warn;

use crate::api::auth::ApiCredentials;

pub fn web_service() -> impl HttpServiceFactory {
    #[cfg(debug_assertions)]
    let files = Files::new("/", "dist").index_file("index.html");

    #[cfg(not(debug_assertions))]
    let files = Files::new("/", "static").index_file("index.html");

    files
        .use_etag(true)
        .use_last_modified(true)
}

pub fn web_config_js_service() -> impl HttpServiceFactory {
    services![config_js]
}
#[get("/config.js")]
async fn config_js(credentials: Data<ApiCredentials>, config: Data<Config>) -> HttpResponse {
    let config_json = match serde_json::to_string(&ConfigJs {
        enable_credential_authentication: credentials.enable_credential_authentication(),
        path_prefix: config.web_path_prefix.clone(),
    }) {
        Ok(value) => value,
        Err(err) => {
            warn!(
                "failed to create the web config.js. The Web Interface might fail to load! {err:?}"
            );

            return HttpResponse::InternalServerError().finish();
        }
    };
    let config_js = format!("export default {config_json}");

    HttpResponse::Ok()
        .append_header(("Content-Type", "text/javascript"))
        .body(config_js)
}
