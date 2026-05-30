import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // Optional ICS calendar invite. method REQUEST adds/updates the event in
  // the recipient's calendar; CANCEL withdraws it.
  ics?: { filename: string; content: string; method: 'REQUEST' | 'CANCEL' };
}

// SmtpService wraps nodemailer. Transport is selected from env, mirroring
// v1's infrastructure/email/smtp.go:
//
//   SMTP_HOST unset            → log-only sender (dev). Logs metadata so a
//                                developer can confirm the worker fired
//                                without a real relay.
//   SMTP_PORT 465 / SMTP_TLS=t → implicit TLS (secure socket).
//   SMTP_PORT 587 (default)    → STARTTLS on a plain socket; we refuse to
//                                send credentials if the server won't upgrade.
//   other                      → plain/opportunistic STARTTLS.
//
// The ICS part is attached as text/calendar with the matching `method=`
// parameter so Outlook/Gmail render it as an invite rather than a file.
@Injectable()
export class SmtpService implements OnModuleInit {
  private readonly log = new Logger(SmtpService.name);
  private transport: nodemailer.Transporter | null = null;
  private readonly from = process.env.SMTP_FROM || 'no-reply@fsd-mrbs.local';

  onModuleInit() {
    const host = process.env.SMTP_HOST;
    if (!host) {
      this.log.warn('SMTP_HOST not set — using log-only mail sender (no email will be delivered)');
      return;
    }
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const forceTLS = (process.env.SMTP_TLS || '').toLowerCase() === 'true';
    const user = process.env.SMTP_USERNAME || '';
    const pass = process.env.SMTP_PASSWORD || '';
    // `secure: true` opens an implicit-TLS socket (465). For 587 we leave it
    // false and require STARTTLS so credentials are never sent in cleartext.
    const secure = forceTLS || port === 465;
    this.transport = nodemailer.createTransport({
      host, port, secure,
      requireTLS: !secure && port === 587,
      auth: user ? { user, pass } : undefined,
      tls: { minVersion: 'TLSv1.2' },
    });
    this.log.log(`SMTP configured: ${host}:${port} (secure=${secure})`);
  }

  isConfigured(): boolean {
    return this.transport !== null;
  }

  // Sends one message. Throws on failure so the caller (outbox drain) can
  // retry with backoff. In log-only mode it never throws.
  async send(msg: OutgoingMail): Promise<void> {
    if (!this.transport) {
      this.log.log(`[mail/log] to=${msg.to} subject=${JSON.stringify(msg.subject)} ics=${msg.ics ? msg.ics.content.length + 'B' : 'none'}`);
      return;
    }
    const attachments = msg.ics
      ? [{
          filename: msg.ics.filename,
          content: msg.ics.content,
          // The method param is what makes mail clients treat this as an
          // invite/cancellation rather than an opaque attachment.
          contentType: `text/calendar; charset=UTF-8; method=${msg.ics.method}`,
        }]
      : undefined;
    await this.transport.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text || stripHtml(msg.html),
      attachments,
      // Mirror the ICS as an alternative so Outlook surfaces Accept/Decline
      // inline as well as via the attachment.
      ...(msg.ics
        ? { alternatives: [{ contentType: `text/calendar; method=${msg.ics.method}; charset=UTF-8`, content: msg.ics.content }] }
        : {}),
    });
  }
}

// Naive HTML→text fallback for clients that don't render HTML. Mirrors the
// stripHTML helper in v1's smtp.go.
export function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\s+\n/g, '\n').trim();
}
