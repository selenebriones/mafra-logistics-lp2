import type { APIRoute } from "astro";

export const prerender = false;

const requiredFields = ["nombre", "empresa", "correo", "telefono", "unidad", "ruta"] as const;

type ContactField = (typeof requiredFields)[number];

const brevoEmailEndpoint = "https://api.brevo.com/v3/smtp/email";
const genericErrorMessage = "Ocurrió un problema al enviar tu solicitud. Intenta de nuevo.";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function normalizeValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function readPayload(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return await request.json();
  }

  const formData = await request.formData();
  return Object.fromEntries(formData.entries());
}

export const POST: APIRoute = async ({ request }) => {
  let payload: Record<string, unknown>;

  try {
    payload = await readPayload(request);
  } catch {
    return json({ ok: false, message: "No pudimos leer los datos del formulario." }, 400);
  }

  if (normalizeValue(payload.website)) {
    return json({ ok: true });
  }

  const contact = requiredFields.reduce<Record<ContactField, string>>((fields, field) => {
    fields[field] = normalizeValue(payload[field]);
    return fields;
  }, {} as Record<ContactField, string>);

  const missingFields = requiredFields.filter((field) => !contact[field]);

  if (missingFields.length > 0) {
    return json({ ok: false, message: "Completa todos los campos requeridos." }, 400);
  }

  if (!isValidEmail(contact.correo)) {
    return json({ ok: false, message: "Ingresa un correo válido." }, 400);
  }

  const brevoApiKey = import.meta.env.BREVO_API_KEY;
  const n8nWebhookUrl = import.meta.env.N8N_WEBHOOK_URL;

  if (!brevoApiKey) {
    console.error("BREVO_API_KEY no está configurada.");
    return json({ ok: false, message: genericErrorMessage }, 500);
  }

  if (!n8nWebhookUrl) {
    console.error("N8N_WEBHOOK_URL no está configurado.");
    return json({ ok: false, message: genericErrorMessage }, 500);
  }

  const submittedAt = new Date().toISOString();
  const emailData = {
    sender: { name: "Fletes industriales NL", email: "noreply@futurite.info" },
    to: [
      { email: "sales@mafragrp.com", name: "sales@mafragrp.com" },
      { email: "dev@futurite.com", name: "Dev Futurite" },
    ],
    replyTo: { email: contact.correo, name: contact.nombre },
    subject: `Nuevo Lead: Fletes industriales NL - ${contact.nombre}`,
    htmlContent: `
      <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #546e7a;">Nuevo Prospecto Registrado</h2>
        <p>Se ha recibido una nueva solicitud de cotización para <strong>Fletes industriales NL</strong>.</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p><strong>Nombre:</strong> ${escapeHtml(contact.nombre)}</p>
        <p><strong>Empresa:</strong> ${escapeHtml(contact.empresa)}</p>
        <p><strong>Email:</strong> ${escapeHtml(contact.correo)}</p>
        <p><strong>WhatsApp/Teléfono:</strong> ${escapeHtml(contact.telefono)}</p>
        <p><strong>Tipo de unidad requerida:</strong> ${escapeHtml(contact.unidad)}</p>
        <p><strong>Ruta origen/destino:</strong> ${escapeHtml(contact.ruta)}</p>
        <p><strong>Fecha de registro:</strong> ${escapeHtml(submittedAt)}</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 12px; color: #999;">Este mensaje fue enviado automáticamente desde la Landing Page.</p>
      </div>
    `,
  };

  const brevoResponse = await fetch(brevoEmailEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": brevoApiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(emailData),
  });

  if (!brevoResponse.ok) {
    const errorData = await brevoResponse.json().catch(() => null);
    console.error("Error de Brevo:", errorData);
    return json({ ok: false, message: genericErrorMessage }, 502);
  }

  const n8nResponse = await fetch(n8nWebhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      nombre: contact.nombre,
      empresa: contact.empresa,
      correo: contact.correo,
      telefono: contact.telefono,
      tipo_unida: contact.unidad,
      ruta: contact.ruta,
    }),
  });

  if (!n8nResponse.ok) {
    const errorData = await n8nResponse.json().catch(() => null);
    console.error("Error de n8n:", errorData);
    return json({ ok: false, message: genericErrorMessage }, 502);
  }

  return json({ ok: true, message: "Recibimos tu solicitud. Te contactaremos en breve." });
};