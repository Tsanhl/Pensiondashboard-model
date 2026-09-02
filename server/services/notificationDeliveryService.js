import { isoNow } from "../utils/values.js";
import {
  appendAuditEvent,
  newId,
  readPortfolio,
  readNotificationDeliveries,
  writeNotificationDeliveries
} from "../store/userDataStore.js";

const CHANNEL_ENV = {
  email_summary: "EMAIL_WEBHOOK_URL",
  phone_push: "PUSH_WEBHOOK_URL"
};

function deliveryProvider(channel, destination = "") {
  if (channel === "email_summary") {
    if (process.env.RESEND_API_KEY && destination) return "resend";
    if (process.env.SENDGRID_API_KEY && destination) return "sendgrid";
    if (process.env.POSTMARK_SERVER_TOKEN && destination) return "postmark";
    if (process.env.AWS_SES_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && destination) return "aws_ses";
    if (process.env.EMAILJS_SERVICE_ID && process.env.EMAILJS_TEMPLATE_ID && process.env.EMAILJS_PUBLIC_KEY && destination) return "emailjs";
    if (process.env.EMAIL_WEBHOOK_URL) return "webhook";
    return "dry_run";
  }
  if (channel === "phone_push") return process.env.PUSH_WEBHOOK_URL ? "webhook" : "dry_run";
  return "dry_run";
}

function externalChannels(notification = {}) {
  return (notification.channels || []).filter((channel) => channel !== "in_app");
}

export function queueNotificationDelivery(userId, notification = {}) {
  const channels = externalChannels(notification);
  if (!channels.length) return [];
  const profile = readPortfolio(userId, {})?.profile || {};
  const deliveries = readNotificationDeliveries(userId);
  const existingKeys = new Set(deliveries.map((delivery) => delivery.deliveryKey));
  const queued = [];
  for (const channel of channels) {
    const deliveryKey = `${notification.id}:${channel}`;
    if (existingKeys.has(deliveryKey)) continue;
    const destination = channel === "email_summary" ? String(profile.email || "") : "";
    queued.push({
      id: newId("delivery"),
      deliveryKey,
      notificationId: notification.id,
      channel,
      provider: deliveryProvider(channel, destination),
      status: "queued",
      title: notification.title,
      body: notification.body,
      linkedView: notification.linkedView,
      destination,
      sendPolicy: notification.priority === "high" || notification.category === "security" ? "immediate" : "in_app_only",
      attempts: 0,
      createdAt: isoNow(),
      updatedAt: isoNow(),
      deliveredAt: null,
      error: ""
    });
  }
  if (queued.length) writeNotificationDeliveries(userId, [...queued, ...deliveries].slice(0, 500));
  return queued;
}

export function listNotificationDeliveries(userId, { status = "all" } = {}) {
  const deliveries = readNotificationDeliveries(userId);
  return status === "all" ? deliveries : deliveries.filter((delivery) => delivery.status === status);
}

async function postWebhook(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Webhook failed with status ${response.status}`);
}

async function sendWithResend(delivery) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "Pension Plan <alerts@example.com>",
      to: [delivery.destination],
      subject: delivery.title,
      text: `${delivery.body}\n\nOpen dashboard section: ${delivery.linkedView || "overview"}`
    })
  });
  if (!response.ok) throw new Error(`Resend failed with status ${response.status}`);
}

async function sendWithSendGrid(delivery) {
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: delivery.destination }] }],
      from: { email: process.env.EMAIL_FROM || "alerts@example.com", name: "Pension Plan" },
      subject: delivery.title,
      content: [{ type: "text/plain", value: `${delivery.body}\n\nOpen dashboard section: ${delivery.linkedView || "overview"}` }]
    })
  });
  if (!response.ok) throw new Error(`SendGrid failed with status ${response.status}`);
}

async function sendWithPostmark(delivery) {
  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "X-Postmark-Server-Token": process.env.POSTMARK_SERVER_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      From: process.env.EMAIL_FROM || "alerts@example.com",
      To: delivery.destination,
      Subject: deliverySubject(delivery),
      TextBody: deliveryMessage(delivery),
      MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound"
    })
  });
  if (!response.ok) throw new Error(`Postmark failed with status ${response.status}`);
}

async function sha256Hex(value) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

async function hmacSha256(key, value, output = undefined) {
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", key).update(value).digest(output);
}

async function awsSigningKey(secretKey, dateStamp, region, service) {
  const kDate = await hmacSha256(Buffer.from(`AWS4${secretKey}`, "utf8"), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function awsTimestamp(date = new Date()) {
  const basic = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: basic, dateStamp: basic.slice(0, 8) };
}

async function sendWithAwsSes(delivery) {
  const region = process.env.AWS_SES_REGION;
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN || "";
  const host = `email.${region}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const endpoint = `https://${host}${path}`;
  const body = JSON.stringify({
    FromEmailAddress: process.env.EMAIL_FROM || "alerts@example.com",
    Destination: { ToAddresses: [delivery.destination] },
    Content: {
      Simple: {
        Subject: { Data: deliverySubject(delivery), Charset: "UTF-8" },
        Body: { Text: { Data: deliveryMessage(delivery), Charset: "UTF-8" } }
      }
    }
  });
  const { amzDate, dateStamp } = awsTimestamp();
  const canonicalHeaders = [
    "content-type:application/json",
    `host:${host}`,
    `x-amz-date:${amzDate}`,
    sessionToken ? `x-amz-security-token:${sessionToken}` : null
  ].filter(Boolean).join("\n") + "\n";
  const signedHeaders = ["content-type", "host", "x-amz-date", sessionToken ? "x-amz-security-token" : null].filter(Boolean).join(";");
  const scope = `${dateStamp}/${region}/ses/aws4_request`;
  const canonicalRequest = [
    "POST",
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(body)
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest)
  ].join("\n");
  const signingKey = await awsSigningKey(secretKey, dateStamp, region, "ses");
  const signature = await hmacSha256(signingKey, stringToSign, "hex");
  const headers = {
    "Content-Type": "application/json",
    "X-Amz-Date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
  if (sessionToken) headers["X-Amz-Security-Token"] = sessionToken;
  const response = await fetch(endpoint, { method: "POST", headers, body });
  if (!response.ok) throw new Error(`AWS SES failed with status ${response.status}`);
}

function plainEmailText(value = "", fallback = "") {
  return String(value || fallback)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function deliverySubject(delivery) {
  return plainEmailText(delivery.title, "Urgent pension dashboard task");
}

function deliveryMessage(delivery) {
  const title = deliverySubject(delivery);
  const body = plainEmailText(delivery.body, "Open the dashboard to review this urgent pension task.");
  const view = plainEmailText(delivery.linkedView, "overview");
  return `${title}\n\n${body}\n\nOpen dashboard section: ${view}`;
}

async function sendWithEmailJs(delivery) {
  const subject = deliverySubject(delivery);
  const message = deliveryMessage(delivery);
  const payload = {
    service_id: process.env.EMAILJS_SERVICE_ID,
    template_id: process.env.EMAILJS_TEMPLATE_ID,
    user_id: process.env.EMAILJS_PUBLIC_KEY,
    template_params: {
      to_email: delivery.destination,
      to_name: delivery.destination,
      from_name: "Pension Plan",
      from_email: process.env.EMAIL_FROM || "alerts@example.com",
      reply_to: process.env.EMAIL_REPLY_TO || delivery.destination,
      subject,
      title: subject,
      message,
      message_plain: message,
      alert_title: subject,
      alert_body: plainEmailText(delivery.body, "Open the dashboard to review this urgent pension task."),
      linked_view: delivery.linkedView || "overview"
    }
  };
  if (process.env.EMAILJS_PRIVATE_KEY) payload.accessToken = process.env.EMAILJS_PRIVATE_KEY;

  const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`EmailJS failed with status ${response.status}`);
}

export async function flushNotificationDeliveries(userId, { limit = 20 } = {}) {
  const deliveries = readNotificationDeliveries(userId);
  const queue = deliveries.filter((delivery) => delivery.status === "queued" || delivery.status === "retry").slice(0, limit);
  for (const delivery of queue) {
    delivery.attempts += 1;
    delivery.updatedAt = isoNow();
    const webhook = process.env[CHANNEL_ENV[delivery.channel]];
    try {
      if (delivery.provider === "resend") {
        await sendWithResend(delivery);
        delivery.status = "delivered";
        delivery.deliveredAt = isoNow();
        delivery.error = "";
      } else if (delivery.provider === "emailjs") {
        await sendWithEmailJs(delivery);
        delivery.status = "delivered";
        delivery.deliveredAt = isoNow();
        delivery.error = "";
      } else if (delivery.provider === "sendgrid") {
        await sendWithSendGrid(delivery);
        delivery.status = "delivered";
        delivery.deliveredAt = isoNow();
        delivery.error = "";
      } else if (delivery.provider === "postmark") {
        await sendWithPostmark(delivery);
        delivery.status = "delivered";
        delivery.deliveredAt = isoNow();
        delivery.error = "";
      } else if (delivery.provider === "aws_ses") {
        await sendWithAwsSes(delivery);
        delivery.status = "delivered";
        delivery.deliveredAt = isoNow();
        delivery.error = "";
      } else if (webhook) {
        await postWebhook(webhook, { userId, delivery });
        delivery.status = "delivered";
        delivery.provider = "webhook";
        delivery.deliveredAt = isoNow();
        delivery.error = "";
      } else {
        delivery.status = "dry_run";
        delivery.provider = "dry_run";
        delivery.deliveredAt = isoNow();
        delivery.error = "No provider webhook configured";
      }
    } catch (error) {
      delivery.status = delivery.attempts >= 3 ? "failed" : "retry";
      delivery.error = error.message;
      appendAuditEvent(userId, {
        type: "notification_delivery_failed",
        deliveryId: delivery.id,
        provider: delivery.provider,
        channel: delivery.channel,
        status: delivery.status,
        error: error.message
      });
    }
  }
  writeNotificationDeliveries(userId, deliveries);
  return { processed: queue.length, deliveries: queue };
}
