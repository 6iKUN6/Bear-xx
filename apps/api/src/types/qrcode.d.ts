declare module 'qrcode' {
  interface ToBufferOptions {
    type?: 'png';
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    width?: number;
  }

  function toBuffer(text: string, options?: ToBufferOptions): Promise<Buffer>;

  export { toBuffer };
}
