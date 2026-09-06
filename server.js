const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const SibApiV3Sdk = require("sib-api-v3-sdk");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const multer = require("multer");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const https = require("https");

const app = express();

// O Render corre atrás de um proxy — sem isto o rate limit e o remoteip do
// Turnstile veem sempre o mesmo IP para todos os visitantes.
app.set("trust proxy", 1);

// ─────────────────────────────────────────────
// CORS — restrito às origens conhecidas do Fin+
// ─────────────────────────────────────────────
const allowedOrigins = [
  "https://ricardotdi.github.io",
  "https://finmais.pt",
  "https://www.finmais.pt",
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
}));

app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

// ─────────────────────────────────────────────
// JWT AUTH
// ─────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Demasiadas tentativas de login. Tente novamente mais tarde." },
});

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function requireAdminAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ success: false, message: "Não autenticado" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== "admin") throw new Error("role inválido");
    next();
  } catch {
    res.status(401).json({ success: false, message: "Sessão inválida ou expirada" });
  }
}

function requireClientAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ success: false, message: "Não autenticado" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== "client") throw new Error("role inválido");
    req.clientAuth = payload;
    next();
  } catch {
    res.status(401).json({ success: false, message: "Sessão inválida ou expirada" });
  }
}

// ─────────────────────────────────────────────
// BREVO CONFIG (SDK — widgets existentes)
// ─────────────────────────────────────────────
let defaultClient = SibApiV3Sdk.ApiClient.instance;
let apiKey = defaultClient.authentications["api-key"];
apiKey.apiKey = process.env.BREVO_API_KEY;
const brevo = new SibApiV3Sdk.TransactionalEmailsApi();

// ─────────────────────────────────────────────
// BREVO CONFIG (SMTP — portal de clientes)
// ─────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp-relay.brevo.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  auth: {
    user: process.env.SMTP_USER || "geral@finmais.pt",
    pass: process.env.SMTP_PASS || process.env.BREVO_SMTP_PASS || "",
  },
});

// ─────────────────────────────────────────────
// SUPABASE CONFIG
// ─────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─────────────────────────────────────────────
// MULTER (upload portal — memória)
// ─────────────────────────────────────────────
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ─────────────────────────────────────────────
// PORTAL — Storage JSON local
// ─────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "data.json");

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ clients: [], invites: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function isWindowActive(w) {
  const now = new Date();
  return new Date(w.start) <= now && new Date(w.end) >= now;
}

function isUploadActive(process) {
  return (process.uploadWindows || []).some(isWindowActive);
}

// ═══════════════════════════════════════════════════════════
//  ROTAS EXISTENTES (widgets) — INALTERADAS
// ═══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────
// ADMIN — Gerar link (sistema antigo)
// ─────────────────────────────────────────────
app.post("/admin/gerar-link", async (req, res) => {
  const { adminPassword, clienteNome } = req.body;
  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Password incorreta." });
  }
  if (!clienteNome) {
    return res.status(400).json({ success: false, error: "Nome do cliente obrigatório." });
  }
  const token = crypto.randomBytes(16).toString("hex");
  const expiraEm = new Date();
  expiraEm.setDate(expiraEm.getDate() + 15);
  const { error } = await supabase.from("links").insert({
    token,
    cliente_nome: clienteNome,
    expira_em: expiraEm.toISOString()
  });
  if (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
  const link = `https://ricardotdi.github.io/widget-credito/finmais-upload.html?token=${token}`;
  res.json({ success: true, link, expiraEm });
});

// ─────────────────────────────────────────────
// ADMIN — Listar links (sistema antigo)
// ─────────────────────────────────────────────
app.get("/admin/listar-links", async (req, res) => {
  const { adminPassword } = req.query;
  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: "Password incorreta." });
  }
  const { data, error } = await supabase
    .from("links")
    .select("*")
    .order("criado_em", { ascending: false });
  if (error) return res.status(500).json({ success: false, error: error.message });
  res.json({ success: true, links: data });
});

// ─────────────────────────────────────────────
// VALIDAR TOKEN (sistema antigo)
// ─────────────────────────────────────────────
app.get("/validar-token", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.json({ valid: false, motivo: "Token em falta." });
  const { data, error } = await supabase
    .from("links")
    .select("*")
    .eq("token", token)
    .single();
  if (error || !data) return res.json({ valid: false, motivo: "Link inválido." });
  const agora = new Date();
  const expira = new Date(data.expira_em);
  if (agora > expira) return res.json({ valid: false, motivo: "Este link expirou." });
  res.json({ valid: true, clienteNome: data.cliente_nome });
});

// ─────────────────────────────────────────────
// ANTI-SPAM DOS FORMULÁRIOS (rate limit + honeypot + Turnstile + escaping)
// ─────────────────────────────────────────────
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
// Modo suave por omissão: um token em falta apenas gera aviso no log.
// Só depois de o frontend estar em produção é que se põe TURNSTILE_ENFORCE=true.
const TURNSTILE_ENFORCE = process.env.TURNSTILE_ENFORCE === "true";

const leadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Demasiados pedidos enviados. Tente novamente dentro de alguns minutos." },
});

// Valida o token do Cloudflare Turnstile. Usa o módulo https nativo para não
// depender da versão de Node do Render (fetch global só existe a partir do 18).
function verifyTurnstile(token, ip) {
  return new Promise((resolve) => {
    if (!TURNSTILE_SECRET || !token) return resolve(false);
    const payload = new URLSearchParams({
      secret: TURNSTILE_SECRET,
      response: token,
      ...(ip ? { remoteip: ip } : {}),
    }).toString();

    const request = https.request({
      hostname: "challenges.cloudflare.com",
      path: "/turnstile/v0/siteverify",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 8000,
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body).success === true);
        } catch (e) {
          console.error("Turnstile: resposta inválida", body);
          resolve(false);
        }
      });
    });

    request.on("timeout", () => { request.destroy(); resolve(false); });
    request.on("error", (err) => { console.error("Turnstile: erro de rede", err.message); resolve(false); });
    request.write(payload);
    request.end();
  });
}

// Escapa HTML. Não escapa a plica, para não estragar nomes tipo O'Brien nos
// emails — todos os campos são interpolados em texto, nunca dentro de atributos.
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Escapa recursivamente todas as strings do corpo do pedido, exceto o email
// (que é validado por regex e usado como endereço de destino real).
function escapeBody(value, key) {
  if (typeof value === "string") return key === "email" ? value : escHtml(value);
  if (Array.isArray(value)) return value.map((v) => escapeBody(v));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = escapeBody(value[k], k);
    return out;
  }
  return value;
}

// A plica é permitida (o'brien@exemplo.pt é válido); só bloqueamos os
// caracteres que teriam significado em HTML, já que o email não é escapado.
const EMAIL_RE = /^[^\s@<>"&]+@[^\s@<>"&,]+\.[a-zA-Z]{2,}$/;
const TELEFONE_RE = /^[\d\s+().-]{6,25}$/;

// Resposta de falso sucesso: o bot fica convencido de que passou e não tenta
// variações, mas nenhum email é enviado.
function fakeSuccess(res, motivo, req) {
  console.warn(`Lead bloqueada (${motivo}) — IP ${req.ip}`);
  return res.json({ success: true });
}

async function leadGuard(req, res, next) {
  const body = req.body || {};

  // 1. Honeypot — campo escondido que só um bot preenche.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return fakeSuccess(res, "honeypot", req);
  }

  // 2. Tempo mínimo entre carregar a página e submeter.
  const ts = Number(body.ts);
  if (ts && Date.now() - ts < 3000) {
    return fakeSuccess(res, "submissão demasiado rápida", req);
  }

  // 3. Validação básica dos campos.
  const nome = typeof body.nome === "string" ? body.nome.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const telefone = typeof body.telefone === "string" ? body.telefone.trim() : "";
  const mensagem = typeof body.mensagem === "string" ? body.mensagem : "";

  if (nome.length < 2 || nome.length > 80) {
    return res.status(400).json({ success: false, message: "Nome inválido." });
  }
  if (/https?:|:\/\/|[\r\n]/i.test(nome) || /https?:|:\/\/|[\r\n]/i.test(telefone)) {
    return fakeSuccess(res, "links no nome/telefone", req);
  }
  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, message: "Email inválido." });
  }
  if (telefone && !TELEFONE_RE.test(telefone)) {
    return res.status(400).json({ success: false, message: "Telefone inválido." });
  }
  if (mensagem.length > 2000) {
    return res.status(400).json({ success: false, message: "Mensagem demasiado longa." });
  }

  // 4. Turnstile.
  const ok = await verifyTurnstile(body.turnstileToken, req.ip);
  if (!ok) {
    if (TURNSTILE_ENFORCE) {
      return res.status(403).json({ success: false, message: "Verificação de segurança falhou. Recarregue a página e tente novamente." });
    }
    console.warn(`Turnstile sem validação (modo suave) — IP ${req.ip}`);
  }

  // Campos de controlo não devem chegar aos emails.
  delete body.website;
  delete body.ts;
  delete body.turnstileToken;

  req.body = escapeBody(body);
  next();
}

// ─────────────────────────────────────────────
// ROTA LEADS
// ─────────────────────────────────────────────
app.post("/send-email", leadLimiter, leadGuard, async (req, res) => {
  try {
    const {
      nome, email, telefone, horario, simulador, mensagem,
      valorCredito, prazo, carencia, tipoCredito, tipoTaxa,
      rendimentoLiquido, dsti,
      rendimento, outrasPrestacoes, montanteMaximo,
      valorCompra, imt, totalImpostos, tabelaAplicada
    } = req.body;

    const formatEuro = (val) => {
      const num = parseFloat(String(val).replace(/[^\d.,]/g, "").replace(",", "."));
      if (isNaN(num)) return val;
      return num.toLocaleString("pt-PT", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const valorCreditoFmt = valorCredito ? formatEuro(valorCredito) : "";
    const rendimentoFmt = rendimentoLiquido ? formatEuro(rendimentoLiquido) : (rendimento ? formatEuro(rendimento) : "");
    const outrasFmt = outrasPrestacoes ? formatEuro(outrasPrestacoes) : "";
    const valorCompraFmt = valorCompra ? formatEuro(valorCompra) : "";

    const temResumo = !!(valorCreditoFmt || prazo || tipoTaxa || montanteMaximo || valorCompraFmt || imt || totalImpostos);

    const resumoSimulacao = `
      ${montanteMaximo ? `<p><strong>Montante máximo financiável:</strong> ${montanteMaximo}</p>` : ""}
      ${valorCompraFmt ? `<p><strong>Valor de compra do imóvel:</strong> ${valorCompraFmt}</p>` : ""}
      ${valorCreditoFmt ? `<p><strong>Valor do crédito:</strong> ${valorCreditoFmt}</p>` : ""}
      ${tipoCredito ? `<p><strong>Tipo de Crédito:</strong> ${tipoCredito}</p>` : ""}
      ${prazo ? `<p><strong>Prazo:</strong> ${prazo}</p>` : ""}
      ${carencia ? `<p><strong>Carência de capital:</strong> ${carencia}</p>` : ""}
      ${tipoTaxa ? `<p><strong>Tipo de Taxa:</strong> ${tipoTaxa}</p>` : ""}
      ${rendimentoFmt ? `<p><strong>Rendimento Líquido Mensal:</strong> ${rendimentoFmt}</p>` : ""}
      ${outrasFmt ? `<p><strong>Outras prestações mensais:</strong> ${outrasFmt}</p>` : ""}
      ${dsti ? `<p><strong>Taxa de Esforço (DSTI):</strong> ${dsti}</p>` : ""}
      ${imt ? `<p><strong>IMT:</strong> ${imt}</p>` : ""}
      ${totalImpostos ? `<p><strong>Total de Impostos (IMT + IS):</strong> ${totalImpostos}</p>` : ""}
      ${tabelaAplicada ? `<p><strong>Tabela aplicada:</strong> ${tabelaAplicada}</p>` : ""}
    `;

    const htmlInterno = `
      <h2>Novo pedido de contacto / simulação</h2>
      ${simulador ? `<p><strong>Simulador:</strong> ${simulador}</p>` : ""}
      <p><strong>Nome:</strong> ${nome}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Telefone:</strong> ${telefone}</p>
      <p><strong>Horário preferencial de contacto:</strong> ${horario || "Qualquer hora"}</p>
      ${mensagem ? `<p><strong>Assunto / Mensagem:</strong> ${mensagem}</p>` : ""}
      ${resumoSimulacao}
    `;

    await brevo.sendTransacEmail({
      sender: { name: "FinMais", email: "geral@finmais.pt" },
      to: [{ email: "geral.finmais@gmail.com" }],
      cc: [{ email: "geral@finmais.pt" }],
      subject: simulador ? `Novo pedido de contacto — ${nome} (${simulador})` : `Novo pedido de contacto — ${nome}`,
      htmlContent: htmlInterno
    });

    if (email) {
      const horarioTexto = horario && horario !== "qualquer"
        ? ", preferencialmente <strong>" + horario + "</strong>"
        : "";

      const introTexto = temResumo
        ? `Obrigado pelo seu contacto. Recebemos a sua simulação${simulador ? ` de <strong>${simulador}</strong>` : ""} e entraremos em contacto consigo em breve${horarioTexto} através do número <strong>${telefone || "indicado"}</strong>.`
        : `Obrigado por nos contactar. Entraremos em contacto consigo em breve${horarioTexto} através do número <strong>${telefone || "indicado"}</strong>.`;

      const htmlCliente = `
        <div style="font-family:Arial,sans-serif; max-width:560px; margin:0 auto; color:#333;">
          <h2 style="color:#A19276;">Recebemos o seu pedido!</h2>
          <p>Olá <strong>${nome}</strong>,</p>
          <p>${introTexto}</p>
          ${mensagem ? `<p><strong>O seu assunto:</strong> ${mensagem}</p>` : ""}
          ${temResumo ? `
            <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
            <h3 style="color:#A19276;">Resumo da sua simulação</h3>
            ${resumoSimulacao}
          ` : ""}
          <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
          <p style="font-size:12px; color:#999;">Os seus dados são tratados de forma confidencial e não serão partilhados com terceiros.</p>
          <p style="font-size:12px; color:#999;">Não responda a este email. Para contacto direto, envie um email para <a href="mailto:geral@finmais.pt" style="color:#999;">geral@finmais.pt</a> ou ligue para o 911 511 908.</p>
          <p style="font-size:13px;">Com os melhores cumprimentos,<br/><strong>Equipa FinMais</strong></p>
        </div>
      `;

      await brevo.sendTransacEmail({
        sender: { name: "FinMais", email: "geral@finmais.pt" },
        to: [{ email: email, name: nome }],
        subject: temResumo ? "A sua simulação FinMais — confirmação de pedido" : "O seu contacto FinMais — confirmação de receção",
        htmlContent: htmlCliente
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao enviar email:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────
// ROTA DOCUMENTOS (sistema antigo)
// ─────────────────────────────────────────────
app.post("/send-documents", async (req, res) => {
  try {
    const { clienteNome, docList, ficheiros } = req.body;
    let htmlDocs = "";
    for (const linha of docList) {
      htmlDocs += `<p>${linha}</p>`;
    }
    const html = `
      <h2>📁 Novo envio de documentos</h2>
      <p><strong>Cliente:</strong> ${clienteNome}</p>
      <p><strong>Documentos enviados:</strong> ${ficheiros.length} ficheiro(s)</p>
      <hr/>
      <h3>Detalhe:</h3>
      ${htmlDocs}
      <hr/>
      <p style="color:#888; font-size:12px;">Enviado através do portal FinMais</p>
    `;
    const attachment = ficheiros.map(f => ({ name: f.name, content: f.data }));
    const emailData = {
      sender: { name: "FinMais Portal", email: "geral@finmais.pt" },
      to: [{ email: "geral.finmais@gmail.com" }],
      cc: [{ email: "geral@finmais.pt" }],
      subject: `Documentos recebidos — ${clienteNome}`,
      htmlContent: html,
      attachment
    };
    const response = await brevo.sendTransacEmail(emailData);
    res.json({ success: true, brevoId: response.messageId });
  } catch (error) {
    console.error("Erro ao enviar documentos:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────
// ROTA CRÉDITO CONSOLIDADO
// ─────────────────────────────────────────────
app.post("/send-email-consolidado", leadLimiter, leadGuard, async (req, res) => {
  try {
    const {
      nome, email, telefone, horario,
      creditosConsolidar,
      valorImovel, novoPrazo, tipoTaxa, dadosTaxa,
      montanteExtra, rendimentoLiquido, encargosAtuais,
      capitalConsolidado, novaPrestacao, prestacaoAtual,
      tan, taeg, mtic, poupancaMensal,
      dstiAntes, dstiDepois
    } = req.body;

    const tipoLabel = { variavel: "Variável", fixa: "Fixa", mista: "Mista" }[tipoTaxa] || tipoTaxa;
    let htmlTaxa = `<p><strong>Tipo de taxa:</strong> ${tipoLabel}</p>`;
    if (tipoTaxa === "variavel") {
      if (dadosTaxa?.euribor) htmlTaxa += `<p><strong>Taxa Euribor:</strong> ${dadosTaxa.euribor}</p>`;
      if (dadosTaxa?.spread) htmlTaxa += `<p><strong>Spread:</strong> ${dadosTaxa.spread}</p>`;
    } else if (tipoTaxa === "fixa") {
      if (dadosTaxa?.tanFixo) htmlTaxa += `<p><strong>TAN fixo:</strong> ${dadosTaxa.tanFixo}</p>`;
    } else if (tipoTaxa === "mista") {
      htmlTaxa += `<p><strong>Fase fixa — Prazo:</strong> ${dadosTaxa?.prazoFixo || "—"} &nbsp;|&nbsp; <strong>TAN:</strong> ${dadosTaxa?.tanFixo || "—"}</p>`;
      htmlTaxa += `<p><strong>Fase variável — Prazo:</strong> ${dadosTaxa?.prazoVar || "—"} &nbsp;|&nbsp; <strong>Euribor:</strong> ${dadosTaxa?.euribor || "—"} &nbsp;|&nbsp; <strong>Spread:</strong> ${dadosTaxa?.spread || "—"}</p>`;
    }

    const htmlInterno = `
      <h2 style="color:#A19276;">🔔 Novo pedido — Crédito Consolidado</h2>
      <h3>Dados do cliente</h3>
      <p><strong>Nome:</strong> ${nome}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Telemóvel:</strong> ${telefone}</p>
      <p><strong>Horário preferencial:</strong> ${horario || "Qualquer hora"}</p>
      <hr/>
      <h3>Créditos a consolidar</h3>
      ${(creditosConsolidar || "").split(" | ").map(c => `<p>• ${c}</p>`).join("")}
      <p><strong>Prestação atual total:</strong> ${prestacaoAtual || "—"}</p>
      <p><strong>Encargos mensais atuais:</strong> ${encargosAtuais || "—"}</p>
      <hr/>
      <h3>Imóvel em garantia</h3>
      <p><strong>Valor do imóvel:</strong> ${valorImovel || "—"}</p>
      <hr/>
      <h3>Novo crédito consolidado</h3>
      <p><strong>Prazo pretendido:</strong> ${novoPrazo || "—"}</p>
      ${htmlTaxa}
      ${montanteExtra ? `<p><strong>Montante extra:</strong> ${montanteExtra}</p>` : ""}
      <hr/>
      <h3>Rendimento</h3>
      <p><strong>Rendimento líquido mensal:</strong> ${rendimentoLiquido || "—"}</p>
      <p><strong>Taxa de esforço antes (DSTI):</strong> ${dstiAntes || "—"}</p>
      <p><strong>Taxa de esforço depois (DSTI):</strong> ${dstiDepois || "—"}</p>
      <hr/>
      <h3>Resultados da simulação</h3>
      <p><strong>Capital consolidado:</strong> ${capitalConsolidado || "—"}</p>
      <p><strong>Nova prestação:</strong> ${novaPrestacao || "—"}</p>
      <p><strong>TAN:</strong> ${tan || "—"}</p>
      <p><strong>TAEG:</strong> ${taeg || "—"}</p>
      <p><strong>MTIC (custo total):</strong> ${mtic || "—"}</p>
      <p><strong>Poupança mensal:</strong> ${poupancaMensal || "—"}</p>
    `;

    await brevo.sendTransacEmail({
      sender: { name: "FinMais", email: "geral@finmais.pt" },
      to: [{ email: "geral.finmais@gmail.com" }],
      cc: [{ email: "geral@finmais.pt" }],
      subject: `Novo pedido Crédito Consolidado — ${nome}`,
      htmlContent: htmlInterno
    });

    const horarioTexto = horario && horario !== "Qualquer hora"
      ? `, preferencialmente <strong>${horario}</strong>`
      : "";

    const htmlCliente = `
      <div style="font-family:Arial,sans-serif; max-width:560px; margin:0 auto; color:#333;">
        <h2 style="color:#A19276;">Recebemos o seu pedido!</h2>
        <p>Olá <strong>${nome}</strong>,</p>
        <p>Obrigado pelo seu contacto. Recebemos a sua simulação de consolidação de crédito e entraremos em contacto consigo em breve${horarioTexto}.</p>
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <h3 style="color:#A19276;">Resumo da sua simulação</h3>
        <p><strong>Créditos a consolidar:</strong></p>
        ${(creditosConsolidar || "").split(" | ").map(c => `<p style="margin:2px 0;">• ${c}</p>`).join("")}
        <p><strong>Valor do imóvel em garantia:</strong> ${valorImovel || "—"}</p>
        <p><strong>Prazo pretendido:</strong> ${novoPrazo || "—"}</p>
        ${htmlTaxa}
        ${montanteExtra ? `<p><strong>Montante extra solicitado:</strong> ${montanteExtra}</p>` : ""}
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <h3 style="color:#A19276;">Resultado indicativo</h3>
        <p><strong>Capital consolidado:</strong> ${capitalConsolidado || "—"}</p>
        <p><strong>Nova prestação mensal:</strong> ${novaPrestacao || "—"}</p>
        <p><strong>Prestação atual total:</strong> ${prestacaoAtual || "—"}</p>
        <p><strong>Poupança mensal estimada:</strong> ${poupancaMensal || "—"}</p>
        <p><strong>TAN:</strong> ${tan || "—"} &nbsp;|&nbsp; <strong>TAEG:</strong> ${taeg || "—"}</p>
        <p><strong>MTIC (custo total estimado):</strong> ${mtic || "—"}</p>
        <p><strong>Taxa de esforço antes:</strong> ${dstiAntes || "—"} &nbsp;→&nbsp; <strong>depois:</strong> ${dstiDepois || "—"}</p>
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <p style="font-size:12px; color:#999;">Valores meramente indicativos, sujeitos a análise e aprovação bancária.</p>
        <p style="font-size:13px;">Com os melhores cumprimentos,<br/><strong>Equipa FinMais</strong></p>
      </div>
    `;

    await brevo.sendTransacEmail({
      sender: { name: "FinMais", email: "geral@finmais.pt" },
      to: [{ email: email, name: nome }],
      subject: "A sua simulação de Crédito Consolidado — FinMais",
      htmlContent: htmlCliente
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao enviar email consolidado:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────
// ROTA CRÉDITO MULTIOPÇÕES
// ─────────────────────────────────────────────
app.post("/send-email-multiopcoes", leadLimiter, leadGuard, async (req, res) => {
  try {
    const {
      nome, email, telefone, horario,
      finalidade,
      hipotecaInscrita, capitalAtual, prazoRemanescente,
      idadeProponente1, idadeProponente2,
      montanteLibertar, novoPrazo, tipoTaxa, dadosTaxa,
      rendimentoLiquido, encargosAtuais,
      capitalTotalFinanciado, novaPrestacao, prestacaoAtual,
      tan, taeg, mtic, variacaoPrestacaoMensal,
      dstiAntes, dstiDepois, dstiNovo
    } = req.body;

    const tipoLabel = { variavel: "Variável", fixa: "Fixa", mista: "Mista" }[tipoTaxa] || tipoTaxa;
    let htmlTaxa = `<p><strong>Tipo de taxa:</strong> ${tipoLabel}</p>`;
    if (tipoTaxa === "variavel") {
      if (dadosTaxa?.euribor) htmlTaxa += `<p><strong>Taxa Euribor:</strong> ${dadosTaxa.euribor}</p>`;
      if (dadosTaxa?.spread) htmlTaxa += `<p><strong>Spread:</strong> ${dadosTaxa.spread}</p>`;
    } else if (tipoTaxa === "fixa") {
      if (dadosTaxa?.tanFixo) htmlTaxa += `<p><strong>TAN fixo:</strong> ${dadosTaxa.tanFixo}</p>`;
    } else if (tipoTaxa === "mista") {
      htmlTaxa += `<p><strong>Fase fixa — Prazo:</strong> ${dadosTaxa?.prazoFixo || "—"} &nbsp;|&nbsp; <strong>TAN:</strong> ${dadosTaxa?.tanFixo || "—"}</p>`;
      htmlTaxa += `<p><strong>Fase variável — Prazo:</strong> ${dadosTaxa?.prazoVar || "—"} &nbsp;|&nbsp; <strong>Euribor:</strong> ${dadosTaxa?.euribor || "—"} &nbsp;|&nbsp; <strong>Spread:</strong> ${dadosTaxa?.spread || "—"}</p>`;
    }

    const idadesTexto = idadeProponente2
      ? `${idadeProponente1 || "—"} anos / ${idadeProponente2} anos`
      : `${idadeProponente1 || "—"} anos`;

    const htmlInterno = `
      <h2 style="color:#A19276;">🔔 Novo pedido — Crédito Multiopções</h2>
      <h3>Dados do cliente</h3>
      <p><strong>Nome:</strong> ${nome}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Telemóvel:</strong> ${telefone}</p>
      <p><strong>Horário preferencial:</strong> ${horario || "Qualquer hora"}</p>
      <hr/>
      <h3>Crédito habitação atual</h3>
      <p><strong>Valor da hipoteca inscrita:</strong> ${hipotecaInscrita || "—"}</p>
      <p><strong>Capital em dívida atual:</strong> ${capitalAtual || "—"}</p>
      <p><strong>Prestação atual:</strong> ${prestacaoAtual || "—"}</p>
      <p><strong>Prazo remanescente:</strong> ${prazoRemanescente || "—"}</p>
      <p><strong>Idade dos proponentes:</strong> ${idadesTexto}</p>
      <hr/>
      <h3>Novo crédito multiopções</h3>
      <p><strong>Finalidade:</strong> ${finalidade || "—"}</p>
      <p><strong>Montante a libertar:</strong> ${montanteLibertar || "—"}</p>
      <p><strong>Prazo pretendido:</strong> ${novoPrazo || "—"}</p>
      ${htmlTaxa}
      <hr/>
      <h3>Rendimento</h3>
      <p><strong>Rendimento líquido mensal:</strong> ${rendimentoLiquido || "—"}</p>
      <p><strong>Encargos mensais atuais:</strong> ${encargosAtuais || "—"}</p>
      <p><strong>Taxa de esforço antes (DSTI):</strong> ${dstiAntes || "—"}</p>
      <p><strong>Taxa de esforço depois (DSTI):</strong> ${dstiDepois || "—"}</p>
      <p><strong>DSTI do novo crédito (stress BdP):</strong> ${dstiNovo || "—"}</p>
      <hr/>
      <h3>Resultados da simulação</h3>
      <p><strong>Capital total financiado:</strong> ${capitalTotalFinanciado || "—"}</p>
      <p><strong>Nova prestação:</strong> ${novaPrestacao || "—"}</p>
      <p><strong>TAN:</strong> ${tan || "—"}</p>
      <p><strong>TAEG:</strong> ${taeg || "—"}</p>
      <p><strong>MTIC (custo total):</strong> ${mtic || "—"}</p>
      <p><strong>Variação da prestação mensal:</strong> ${variacaoPrestacaoMensal || "—"}</p>
    `;

    await brevo.sendTransacEmail({
      sender: { name: "FinMais", email: "geral@finmais.pt" },
      to: [{ email: "geral.finmais@gmail.com" }],
      cc: [{ email: "geral@finmais.pt" }],
      subject: `Novo pedido Crédito Multiopções — ${nome}`,
      htmlContent: htmlInterno
    });

    const horarioTexto2 = horario && horario !== "Qualquer hora"
      ? `, preferencialmente <strong>${horario}</strong>`
      : "";

    const htmlCliente = `
      <div style="font-family:Arial,sans-serif; max-width:560px; margin:0 auto; color:#333;">
        <h2 style="color:#A19276;">Recebemos o seu pedido!</h2>
        <p>Olá <strong>${nome}</strong>,</p>
        <p>Obrigado pelo seu contacto. Recebemos a sua simulação de Crédito Multiopções e entraremos em contacto consigo em breve${horarioTexto2}.</p>
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <h3 style="color:#A19276;">Resumo da sua simulação</h3>
        <p><strong>Finalidade:</strong> ${finalidade || "—"}</p>
        <p><strong>Montante a libertar:</strong> ${montanteLibertar || "—"}</p>
        <p><strong>Prazo pretendido:</strong> ${novoPrazo || "—"}</p>
        ${htmlTaxa}
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <h3 style="color:#A19276;">Resultado indicativo</h3>
        <p><strong>Capital total financiado:</strong> ${capitalTotalFinanciado || "—"}</p>
        <p><strong>Nova prestação mensal:</strong> ${novaPrestacao || "—"}</p>
        <p><strong>Prestação atual:</strong> ${prestacaoAtual || "—"}</p>
        <p><strong>Variação da prestação mensal:</strong> ${variacaoPrestacaoMensal || "—"}</p>
        <p><strong>TAN:</strong> ${tan || "—"} &nbsp;|&nbsp; <strong>TAEG:</strong> ${taeg || "—"}</p>
        <p><strong>MTIC (custo total estimado):</strong> ${mtic || "—"}</p>
        <p><strong>Taxa de esforço antes:</strong> ${dstiAntes || "—"} &nbsp;→&nbsp; <strong>depois:</strong> ${dstiDepois || "—"}</p>
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <p style="font-size:12px; color:#999;">Valores meramente indicativos, sujeitos a análise e aprovação bancária.</p>
        <p style="font-size:13px;">Com os melhores cumprimentos,<br/><strong>Equipa FinMais</strong></p>
      </div>
    `;

    await brevo.sendTransacEmail({
      sender: { name: "FinMais", email: "geral@finmais.pt" },
      to: [{ email: email, name: nome }],
      subject: "A sua simulação de Crédito Multiopções — FinMais",
      htmlContent: htmlCliente
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Erro ao enviar email multiopções:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  NOVAS ROTAS — PORTAL DE CLIENTES
// ═══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────
app.post("/admin/login", loginLimiter, (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: "Password incorreta" });
  }
});

app.post("/client/login", loginLimiter, (req, res) => {
  const { email, password } = req.body;
  const data = loadData();
  const client = data.clients.find(c => c.email === email);
  if (!client) return res.status(401).json({ success: false, message: "Email não encontrado" });
  if (!client.passwordHash) return res.status(401).json({ success: false, message: "Conta não ativada" });
  const hash = crypto.createHash("sha256").update(password).digest("hex");
  if (hash !== client.passwordHash) return res.status(401).json({ success: false, message: "Password incorreta" });
  const token = jwt.sign({ role: "client", clientId: client.id, email: client.email }, JWT_SECRET, { expiresIn: "24h" });
  res.json({ success: true, token, client: { id: client.id, name: client.name, email: client.email } });
});

// ─────────────────────────────────────────────
// CONVITES
// ─────────────────────────────────────────────
app.post("/admin/invite", requireAdminAuth, async (req, res) => {
  const { clientId } = req.body;
  const data = loadData();
  const client = data.clients.find(c => c.id === clientId);
  if (!client) return res.status(404).json({ success: false, message: "Cliente não encontrado" });

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  data.invites = data.invites.filter(i => i.clientId !== clientId);
  data.invites.push({ clientId, token, expires });
  saveData(data);

  const activationLink = `${process.env.SITE_URL || "https://credito-backend-ffnk.onrender.com"}/activate?token=${token}`;

  try {
    await transporter.sendMail({
      from: '"Fin+" <geral@finmais.pt>',
      to: client.email,
      subject: "Bem-vindo à sua Área Reservada Fin+",
      html: `
        <div style="font-family: Georgia, serif; max-width: 500px; margin: 0 auto; padding: 40px 20px; color: #2c2c2c;">
          <div style="text-align: center; margin-bottom: 30px;">
            <span style="font-size: 24px; font-weight: bold; color: #978E58; letter-spacing: 2px;">FIN+</span>
          </div>
          <h2 style="color: #2c2c2c; font-weight: normal;">Olá, ${client.name}</h2>
          <p style="line-height: 1.7; color: #555;">Foi criada a sua área reservada na Fin+. Aqui poderá acompanhar o estado do seu processo e enviar documentos de forma segura.</p>
          <div style="text-align: center; margin: 35px 0;">
            <a href="${activationLink}" style="background: #978E58; color: white; padding: 14px 32px; text-decoration: none; font-size: 15px; letter-spacing: 1px; display: inline-block;" clicktracking="off">ATIVAR ACESSO</a>
          </div>
          <p style="font-size: 13px; color: #999; line-height: 1.6;">Este link é válido por 7 dias. Se não solicitou este acesso, ignore este email.</p>
          <p style="font-size: 11px; color: #ccc; line-height: 1.8; word-break: break-all;">Se o botão não funcionar, copia este link:<br>${activationLink}</p>
          <p style="font-size: 12px; color: #bbb; text-align: center;">Fin+ · Intermediário de Crédito · Registo BdP nº 0008693</p>
        </div>
      `,
    });
    res.json({ success: true, message: "Convite enviado com sucesso" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Erro ao enviar email" });
  }
});

app.post("/client/activate", (req, res) => {
  const { token, password } = req.body;
  const data = loadData();
  const invite = data.invites.find(i => i.token === token);
  if (!invite) return res.status(400).json({ success: false, message: "Link inválido ou expirado" });
  if (new Date(invite.expires) < new Date()) return res.status(400).json({ success: false, message: "Link expirado" });

  const client = data.clients.find(c => c.id === invite.clientId);
  if (!client) return res.status(404).json({ success: false, message: "Cliente não encontrado" });

  client.passwordHash = crypto.createHash("sha256").update(password).digest("hex");
  client.activated = true;
  data.invites = data.invites.filter(i => i.token !== token);
  saveData(data);
  res.json({ success: true, message: "Conta ativada com sucesso" });
});

// Redirecionar /activate?token=xxx para o ficheiro HTML do cliente
app.get("/activate", (req, res) => {
  const { token } = req.query;
  const siteUrl = process.env.SITE_URL || "https://ricardotdi.github.io/widget-credito/finmais-upload.html";
  res.redirect(`${siteUrl}?token=${token}`);
});

app.get("/client/check-token", (req, res) => {
  const { token } = req.query;
  const data = loadData();
  const invite = data.invites.find(i => i.token === token);
  if (!invite || new Date(invite.expires) < new Date()) {
    return res.json({ valid: false });
  }
  const client = data.clients.find(c => c.id === invite.clientId);
  res.json({ valid: true, name: client?.name || "" });
});

// ─────────────────────────────────────────────
// CLIENTES (ADMIN PORTAL)
// ─────────────────────────────────────────────
app.get("/admin/clients", requireAdminAuth, (req, res) => {
  const data = loadData();
  res.json(data.clients);
});

app.post("/admin/clients", requireAdminAuth, (req, res) => {
  const { name, email, phone, concelho, processNumber } = req.body;
  const data = loadData();
  if (data.clients.find(c => c.email === email)) {
    return res.status(400).json({ success: false, message: "Email já registado" });
  }
  const now = new Date().toISOString();
  const uploadEnd = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
  const client = {
    id: crypto.randomBytes(8).toString("hex"),
    name, email, phone, concelho, processNumber,
    createdAt: now,
    activated: false,
    passwordHash: null,
    processes: [{
      id: crypto.randomBytes(8).toString("hex"),
      number: processNumber,
      createdAt: now,
      currentStep: 0,
      uploadWindows: [
        { id: crypto.randomBytes(6).toString("hex"), start: now, end: uploadEnd, note: "Janela inicial (15 dias)" }
      ],
    }]
  };
  data.clients.push(client);
  saveData(data);
  res.json({ success: true, client });
});

app.put("/admin/clients/:id", requireAdminAuth, (req, res) => {
  const data = loadData();
  const idx = data.clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  data.clients[idx] = { ...data.clients[idx], ...req.body };
  saveData(data);
  res.json({ success: true, client: data.clients[idx] });
});

app.delete("/admin/clients/:id", requireAdminAuth, (req, res) => {
  const data = loadData();
  data.clients = data.clients.filter(c => c.id !== req.params.id);
  saveData(data);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// PROCESSOS
// ─────────────────────────────────────────────
app.put("/admin/clients/:clientId/processes/:processId/step", requireAdminAuth, (req, res) => {
  const { step } = req.body;
  const data = loadData();
  const client = data.clients.find(c => c.id === req.params.clientId);
  if (!client) return res.status(404).json({ success: false });
  const proc = client.processes.find(p => p.id === req.params.processId);
  if (!proc) return res.status(404).json({ success: false });
  proc.currentStep = step;
  saveData(data);
  res.json({ success: true });
});

app.post("/admin/clients/:clientId/processes", requireAdminAuth, (req, res) => {
  const { number } = req.body;
  const data = loadData();
  const client = data.clients.find(c => c.id === req.params.clientId);
  if (!client) return res.status(404).json({ success: false });
  const now = new Date().toISOString();
  const uploadEnd = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
  const newProcess = {
    id: crypto.randomBytes(8).toString("hex"),
    number, createdAt: now, currentStep: 0,
    uploadWindows: [
      { id: crypto.randomBytes(6).toString("hex"), start: now, end: uploadEnd, note: "Janela inicial (15 dias)" }
    ],
  };
  client.processes.push(newProcess);
  saveData(data);
  res.json({ success: true, process: newProcess });
});

// ─────────────────────────────────────────────
// JANELAS DE UPLOAD
// ─────────────────────────────────────────────
app.post("/admin/clients/:clientId/processes/:processId/upload-windows", requireAdminAuth, (req, res) => {
  const { start, end, note } = req.body;
  const data = loadData();
  const client = data.clients.find(c => c.id === req.params.clientId);
  if (!client) return res.status(404).json({ success: false });
  const proc = client.processes.find(p => p.id === req.params.processId);
  if (!proc) return res.status(404).json({ success: false });
  const win = { id: crypto.randomBytes(6).toString("hex"), start, end, note: note || "" };
  proc.uploadWindows.push(win);
  saveData(data);
  res.json({ success: true, window: win });
});

app.delete("/admin/clients/:clientId/processes/:processId/upload-windows/:windowId", requireAdminAuth, (req, res) => {
  const data = loadData();
  const client = data.clients.find(c => c.id === req.params.clientId);
  if (!client) return res.status(404).json({ success: false });
  const proc = client.processes.find(p => p.id === req.params.processId);
  if (!proc) return res.status(404).json({ success: false });
  proc.uploadWindows = proc.uploadWindows.filter(w => w.id !== req.params.windowId);
  saveData(data);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// ÁREA DO CLIENTE
// ─────────────────────────────────────────────
app.get("/client/me", requireClientAuth, (req, res) => {
  const { email } = req.query;
  if (email !== req.clientAuth.email) {
    return res.status(403).json({ success: false, message: "Acesso negado" });
  }
  const data = loadData();
  const client = data.clients.find(c => c.email === email);
  if (!client) return res.status(404).json({ success: false });
  const { passwordHash, ...safeClient } = client;
  res.json(safeClient);
});

// ─────────────────────────────────────────────
// UPLOAD DE DOCUMENTOS (portal novo)
// ─────────────────────────────────────────────
app.post("/upload", requireClientAuth, upload.array("files", 10), async (req, res) => {
  const { clientEmail, clientName, processNumber } = req.body;
  if (clientEmail !== req.clientAuth.email) {
    return res.status(403).json({ success: false, message: "Acesso negado" });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, message: "Nenhum ficheiro recebido" });
  }
  const data = loadData();
  const client = data.clients.find(c => c.email === clientEmail);
  if (client) {
    const proc = client.processes.find(p => p.number === processNumber);
    if (proc && !isUploadActive(proc)) {
      return res.status(403).json({ success: false, message: "Período de upload não está ativo" });
    }
  }
  const attachments = req.files.map(f => ({
    filename: f.originalname,
    content: f.buffer,
    contentType: f.mimetype,
  }));
  try {
    await transporter.sendMail({
      from: '"Fin+ Portal" <geral@finmais.pt>',
      to: "geral@finmais.pt",
      cc: "geral@finmais.pt",
      subject: `📎 Documentos | ${clientName} | Processo ${processNumber}`,
      html: `
        <div style="font-family: Georgia, serif; padding: 20px; color: #2c2c2c;">
          <h3 style="color: #978E58;">Novos documentos recebidos</h3>
          <p><strong>Cliente:</strong> ${clientName}</p>
          <p><strong>Email:</strong> ${clientEmail}</p>
          <p><strong>Processo:</strong> ${processNumber}</p>
          <p><strong>Ficheiros:</strong> ${req.files.map(f => f.originalname).join(", ")}</p>
          <p><strong>Data:</strong> ${new Date().toLocaleString("pt-PT")}</p>
        </div>
      `,
      attachments,
    });
    res.json({ success: true, message: "Documentos enviados com sucesso" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Erro ao enviar documentos" });
  }
});

// ─────────────────────────────────────────────
// EXPORTAÇÃO CSV
// ─────────────────────────────────────────────
app.get("/admin/export", requireAdminAuth, (req, res) => {
  const data = loadData();
  const rows = data.clients.map(c => {
    const lastProc = c.processes?.[c.processes.length - 1];
    const uploadActive = lastProc ? isUploadActive(lastProc) : false;
    return [
      c.name, c.email, c.phone, c.concelho, c.processNumber,
      new Date(c.createdAt).toLocaleDateString("pt-PT"),
      uploadActive ? "Ativo" : "Inativo",
    ].map(v => `"${(v || "").toString().replace(/"/g, '""')}"`).join(",");
  });
  const header = '"Nome","Email","Telefone","Concelho","Nº Processo","Data Criação","Upload"';
  const csv = [header, ...rows].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="clientes-finmais.csv"');
  res.send("\uFEFF" + csv);
});

// ─────────────────────────────────────────────
// SERVIDOR
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
