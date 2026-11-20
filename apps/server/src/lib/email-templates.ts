export function generateInitialPasswordEmail(
  fullName: string,
  username: string,
  password: string,
  loginUrl: string
): { subject: string; html: string; text: string } {
  const subject = 'Your TRF System Account Credentials';
  const html = `<!DOCTYPE html><html><body><h1>TRF Management System</h1><p>Dear <strong>${fullName}</strong>,</p><p>Account created. Credentials:</p><p><strong>Username:</strong> ${username}</p><p><strong>Password:</strong> ${password}</p><p><strong>Important:</strong> You must change your password on first login.</p><p><a href="${loginUrl}">Sign In</a></p></body></html>`;
  const text = `TRF System - Account Credentials\n\nDear ${fullName},\n\nUsername: ${username}\nPassword: ${password}\n\nIMPORTANT: Change password on first login.\n\nSign in: ${loginUrl}`;
  return { subject, html, text };
}

export function generatePasswordResetEmail(
  fullName: string,
  resetUrl: string,
  expiresInHours: number
): { subject: string; html: string; text: string } {
  const subject = 'Reset Your TRF System Password';
  const html = `<!DOCTYPE html><html><body><h1>TRF Management System</h1><p>Dear <strong>${fullName}</strong>,</p><p>You requested to reset your password.</p><p><a href="${resetUrl}">Reset Password</a></p><p>This link expires in ${expiresInHours} hours.</p></body></html>`;
  const text = `TRF System - Password Reset\n\nDear ${fullName},\n\nReset your password: ${resetUrl}\n\nThis link expires in ${expiresInHours} hours.`;
  return { subject, html, text };
}

export function generatePasswordChangedEmail(fullName: string): { subject: string; html: string; text: string } {
  const subject = 'Your TRF System Password Has Been Changed';
  const html = `<!DOCTYPE html><html><body><h1>TRF Management System</h1><p>Dear <strong>${fullName}</strong>,</p><p>Your password has been changed successfully.</p></body></html>`;
  const text = `TRF System - Password Changed\n\nDear ${fullName},\n\nYour password has been changed successfully.`;
  return { subject, html, text };
}