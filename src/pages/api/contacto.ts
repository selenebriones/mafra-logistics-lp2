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

function createLogger(requestId: string) {
  const prefix = `[api/contacto][${requestId}]`;
  return {
    info: (...args: unknown[]) => console.log(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}

// Vite congela import.meta.env en el build; en Vercel una variable agregada
// después del último deploy solo existe en process.env en runtime.
function getEnv(name: string): string | undefined {
  const buildTime = (import.meta.env as Record<string, string | undefined>)[name];
  const runtime = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return buildTime || runtime;
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
  const requestId = crypto.randomUUID().slice(0, 8);
  const log = createLogger(requestId);

  try {
    log.info("Solicitud recibida", {
      contentType: request.headers.get("content-type"),
      userAgent: request.headers.get("user-agent"),
    });

    let payload: Record<string, unknown>;

    try {
      payload = await readPayload(request);
    } catch (error) {
      log.error("No se pudo parsear el cuerpo de la solicitud:", error);
      return json({ ok: false, message: "No pudimos leer los datos del formulario.", requestId }, 400);
    }

    log.info("Payload parseado. Campos recibidos:", Object.keys(payload));

    if (normalizeValue(payload.website)) {
      log.info("Honeypot activado (campo 'website' con valor); se descarta como spam.");
      return json({ ok: true });
    }

    const contact = requiredFields.reduce<Record<ContactField, string>>((fields, field) => {
      fields[field] = normalizeValue(payload[field]);
      return fields;
    }, {} as Record<ContactField, string>);

    const missingFields = requiredFields.filter((field) => !contact[field]);

    if (missingFields.length > 0) {
      log.info("Validación fallida. Campos faltantes:", missingFields);
      return json({ ok: false, message: "Completa todos los campos requeridos.", requestId }, 400);
    }

    if (!isValidEmail(contact.correo)) {
      log.info("Validación fallida. Correo inválido:", contact.correo);
      return json({ ok: false, message: "Ingresa un correo válido.", requestId }, 400);
    }

    const brevoApiKey = getEnv("BREVO_API_KEY");
    const n8nWebhookUrl = getEnv("N8N_WEBHOOK_URL");

    log.info("Variables de entorno:", {
      BREVO_API_KEY: brevoApiKey ? `presente (${brevoApiKey.length} chars)` : "AUSENTE",
      N8N_WEBHOOK_URL: n8nWebhookUrl ? "presente" : "AUSENTE",
    });

    if (!brevoApiKey) {
      log.error("BREVO_API_KEY no está configurada.");
      return json({ ok: false, message: genericErrorMessage, requestId }, 500);
    }

    if (!n8nWebhookUrl) {
      log.error("N8N_WEBHOOK_URL no está configurado.");
      return json({ ok: false, message: genericErrorMessage, requestId }, 500);
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

    log.info("Enviando correo vía Brevo…");

    let brevoResponse: Response;
    try {
      brevoResponse = await fetch(brevoEmailEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "api-key": brevoApiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(emailData),
      });
    } catch (error) {
      log.error("Fallo de red al llamar a Brevo (fetch lanzó excepción):", error);
      return json({ ok: false, message: genericErrorMessage, requestId }, 502);
    }

    if (!brevoResponse.ok) {
      const errorBody = await brevoResponse.text().catch(() => "(sin cuerpo)");
      log.error(`Brevo respondió ${brevoResponse.status} ${brevoResponse.statusText}:`, errorBody);
      return json({ ok: false, message: genericErrorMessage, requestId }, 502);
    }

    const brevoResult = await brevoResponse.json().catch(() => null);
    log.info("Brevo OK:", brevoResult);

    log.info("Notificando webhook de n8n…");

    let n8nResponse: Response;
    try {
      n8nResponse = await fetch(n8nWebhookUrl, {
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
    } catch (error) {
      log.error("Fallo de red al llamar al webhook de n8n (fetch lanzó excepción):", error);
      return json({ ok: false, message: genericErrorMessage, requestId }, 502);
    }

    if (!n8nResponse.ok) {
      const errorBody = await n8nResponse.text().catch(() => "(sin cuerpo)");
      log.error(`n8n respondió ${n8nResponse.status} ${n8nResponse.statusText}:`, errorBody);
      return json({ ok: false, message: genericErrorMessage, requestId }, 502);
    }

    log.info("Flujo completado con éxito (correo enviado y n8n notificado).");
    return json({ ok: true, message: "Recibimos tu solicitud. Te contactaremos en breve." });
  } catch (error) {
    log.error("Error no controlado en el endpoint:", error instanceof Error ? error.stack ?? error.message : error);
    return json({ ok: false, message: genericErrorMessage, requestId }, 500);
  }
};
