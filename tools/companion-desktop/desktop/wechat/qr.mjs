// QR payload fields follow phoiex/AAAAGENT windows/code/desktop-pet/wechat/qr.ts
// and service.ts at 2752349bcc7f7137b8b9e4ff9cccf34026d77aad.
export const QR_LIFETIME_MS = 5 * 60_000;
export function qrPayload(result, now) {
  if (typeof result?.qrcode !== 'string' || !result.qrcode || result.qrcode.length > 4096 || typeof result.qrcode_img_content !== 'string' || !result.qrcode_img_content || result.qrcode_img_content.length > 8192) throw Error('微信二维码响应无效。');
  // The trusted main-window wiring will render this content with its reviewed QR renderer.
  return { qrcode: result.qrcode, content: result.qrcode_img_content, expiresAt: now + QR_LIFETIME_MS };
}
