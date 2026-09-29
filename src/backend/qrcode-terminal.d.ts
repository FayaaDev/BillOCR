declare module "qrcode-terminal" {
  const qr: { generate(token: string, options: { small: boolean }): void };
  export default qr;
}
