use std::future::Future;
use std::pin::Pin;

pub trait Agent {
    fn execute(&mut self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
}
