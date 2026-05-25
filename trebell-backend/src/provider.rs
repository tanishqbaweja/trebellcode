use std::future::Future;
use std::pin::Pin;

pub trait AIProvider {
    fn generate(
        &self,
        prompt: &str,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;
}
