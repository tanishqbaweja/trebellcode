export function desktopBridgeToolAvailability(bridge=null){
  return {
    browser:Boolean(bridge?.browser),
    computer:Boolean(bridge?.computer&&bridge?.platform==="win32"),
  };
}
