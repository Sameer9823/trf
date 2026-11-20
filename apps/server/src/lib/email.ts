import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config.js';
import { buildLogger } from './logger.js';

let transporter: Transporter | null = null;

let loggerInstance: ReturnType<typeof buildLogger> | null = null;
function getLogger() {
  if (!loggerInstance) loggerInstance = buildLogger();
  return loggerInstance;
}

function getTransporter(): Transporter {
  if (transporter) return transporter;

  if (!config.EMAIL_USER || !config.EMAIL_PASS) {
    throw new Error('Email credentials not configured. Set EMAIL_USER and EMAIL_PASS in .env');
  }

  transporter = nodemailer.createTransport({
    host: config.EMAIL_HOST,
    port: config.EMAIL_PORT,
    secure: config.EMAIL_SECURE,
    auth: {
      user: config.EMAIL_USER,
      pass: config.EMAIL_PASS,
    },
  });

  return transporter;
}

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/** Extract domain from email address for logging (never log full email). */
function recipientDomain(to: string): string {
  const idx = to.lastIndexOf('@');
  return idx >= 0 ? to.slice(idx + 1) : 'unknown';
}

export async function sendEmail(options: EmailOptions, templateName?: string): Promise<boolean> {
  try {
    const transporter = getTransporter();
    const from = config.EMAIL_FROM ?? config.EMAIL_USER ?? 'TRF System <noreply@trf.local>';
    
    await transporter.sendMail({
      from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text ?? options.html.replace(/<[^>]*>/g, ''),
    });
    return true;
  } catch (err) {
    getLogger().error({ 
      err, 
      template: templateName ?? 'unknown',
      recipientDomain: recipientDomain(options.to),
    }, 'Failed to send email');
    return false;
  }
}