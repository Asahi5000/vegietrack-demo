const nodemailer = require('nodemailer');
require('dotenv').config();

let transporter = null;

function getTransporter() {
  if (!process.env.SMTP_HOST) {
    return null; // Dev mode: no SMTP configured
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    });
  }
  return transporter;
}

/**
 * Sends the password reset email. If SMTP is not configured (no SMTP_HOST),
 * falls back to logging the reset link to the console so development/testing
 * can proceed without a real mail server.
 */
async function sendPasswordResetEmail(toEmail, resetUrl) {
  const t = getTransporter();

  if (!t) {
    console.log('\n=== Password Reset (dev mode - no SMTP configured) ===');
    console.log(`To: ${toEmail}`);
    console.log(`Reset link: ${resetUrl}`);
    console.log('=======================================================\n');
    return { delivered: false, devMode: true };
  }

  await t.sendMail({
    from: process.env.SMTP_FROM || '"VegieTrack" <no-reply@vegietrack.local>',
    to: toEmail,
    subject: 'Password Reset Request - VegieTrack',
    html: `
      <p>We received a request to reset your password.</p>
      <p>Click the link below to set a new password. This link expires in 1 hour.</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>If you did not request this, you can safely ignore this email.</p>
    `,
  });

  return { delivered: true, devMode: false };
}

module.exports = { sendPasswordResetEmail };
