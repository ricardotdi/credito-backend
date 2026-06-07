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

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

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
// ROTA LEADS
// ─────────────────────────────────────────────
app.post("/send-email", async (req, res) => {
  try {
    const { nome, email, telefone, horario, valorCredito, prazo, carencia, tipoCredito, tipoTaxa, rendimentoLiquido, dsti, mensagem } = req.body;

    const formatEuro = (val) => {
      const num = parseFloat(String(val).replace(/[^\d.,]/g, "").replace(",", "."));
      if (isNaN(num)) return val;
      return num.toLocaleString("pt-PT", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const valorCreditoFmt = valorCredito ? formatEuro(valorCredito) : "";
    const rendimentoFmt = rendimentoLiquido ? formatEuro(rendimentoLiquido) : "";

    const htmlInterno = `
      <h2>Novo pedido de contacto / simulação</h2>
      <p><strong>Nome:</strong> ${nome}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Telefone:</strong> ${telefone}</p>
      <p><strong>Horário preferencial de contacto:</strong> ${horario || "Qualquer hora"}</p>
      ${mensagem ? `<p><strong>Assunto / Mensagem:</strong> ${mensagem}</p>` : ""}
      ${tipoCredito ? `<p><strong>Tipo de Crédito:</strong> ${tipoCredito}</p>` : ""}
      ${valorCreditoFmt ? `<p><strong>Valor do Crédito:</strong> ${valorCreditoFmt}</p>` : ""}
      ${prazo ? `<p><strong>Prazo:</strong> ${prazo}</p>` : ""}
      ${carencia ? `<p><strong>Carência de capital:</strong> ${carencia}</p>` : ""}
      ${tipoTaxa ? `<p><strong>Tipo de Taxa:</strong> ${tipoTaxa}</p>` : ""}
      ${rendimentoFmt ? `<p><strong>Rendimento Líquido Mensal:</strong> ${rendimentoFmt}</p>` : ""}
      ${dsti ? `<p><strong>Taxa de Esforço (DSTI):</strong> ${dsti}</p>` : ""}
    `;

    await brevo.sendTransacEmail({
      sender: { name: "FinMais", email: "geral@finmais.pt" },
      to: [{ email: "geral.finmais@gmail.com" }],
      cc: [{ email: "geral@finmais.pt" }],
      subject: `Novo pedido de contacto — ${nome}`,
      htmlContent: htmlInterno
    });

    const horarioTexto = horario && horario !== "qualquer"
      ? ", preferencialmente <strong>" + horario + "</strong>"
      : "";

    const htmlCliente = `
      <div style="font-family:Arial,sans-serif; max-width:560px; margin:0 auto; color:#333;">
        <h2 style="color:#A19276;">Recebemos o seu pedido!</h2>
        <p>Olá <strong>${nome}</strong>,</p>
        <p>Obrigado pelo seu contacto. Recebemos a sua simulação e entraremos em contacto consigo em breve${horarioTexto} através do número <strong>${telefone || "indicado"}</strong>.</p>
        ${mensagem ? `<p><strong>O seu assunto:</strong> ${mensagem}</p>` : ""}
        ${(valorCreditoFmt || prazo || tipoTaxa) ? `
          <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
          <h3 style="color:#A19276;">Resumo da sua simulação</h3>
          ${valorCreditoFmt ? `<p><strong>Valor do crédito:</strong> ${valorCreditoFmt}</p>` : ""}
          ${tipoCredito ? `<p><strong>Tipo de crédito:</strong> ${tipoCredito}</p>` : ""}
          ${prazo ? `<p><strong>Prazo:</strong> ${prazo}</p>` : ""}
          ${carencia ? `<p><strong>Carência de capital:</strong> ${carencia}</p>` : ""}
          ${tipoTaxa ? `<p><strong>Tipo de Taxa:</strong> ${tipoTaxa}</p>` : ""}
          ${rendimentoFmt ? `<p><strong>Rendimento Líquido Mensal:</strong> ${rendimentoFmt}</p>` : ""}
          ${dsti ? `<p><strong>Taxa de Esforço (DSTI):</strong> ${dsti}</p>` : ""}
        ` : ""}
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <p style="font-size:12px; color:#999;">Os seus dados são tratados de forma confidencial e não serão partilhados com terceiros.</p>
        <p style="font-size:13px;">Com os melhores cumprimentos,<br/><strong>Equipa FinMais</strong></p>
      </div>
    `;

    await brevo.sendTransacEmail({
      sender: { name: "FinMais", email: "geral@finmais.pt" },
      to: [{ email: email, name: nome }],
      subject: "A sua simulação FinMais — confirmação de pedido",
      htmlContent: htmlCliente
    });

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
app.post("/send-email-consolidado", async (req, res) => {
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

// ═══════════════════════════════════════════════════════════
//  NOVAS ROTAS — PORTAL DE CLIENTES
// ═══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────
app.post("/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: "Password incorreta" });
  }
});

app.post("/client/login", (req, res) => {
  const { email, password } = req.body;
  const data = loadData();
  const client = data.clients.find(c => c.email === email);
  if (!client) return res.status(401).json({ success: false, message: "Email não encontrado" });
  if (!client.passwordHash) return res.status(401).json({ success: false, message: "Conta não ativada" });
  const hash = crypto.createHash("sha256").update(password).digest("hex");
  if (hash !== client.passwordHash) return res.status(401).json({ success: false, message: "Password incorreta" });
  res.json({ success: true, client: { id: client.id, name: client.name, email: client.email } });
});

// ─────────────────────────────────────────────
// CONVITES
// ─────────────────────────────────────────────
app.post("/admin/invite", async (req, res) => {
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
            <a href="${activationLink}" style="background: #978E58; color: white; padding: 14px 32px; text-decoration: none; font-size: 15px; letter-spacing: 1px; display: inline-block;">ATIVAR ACESSO</a>
          </div>
          <p style="font-size: 13px; color: #999; line-height: 1.6;">Este link é válido por 7 dias. Se não solicitou este acesso, ignore este email.</p>
          <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">
          <p style="font-size: 12px; color: #bbb; text-align: center;">Fin+ · Intermediário de Crédito · Registro BdP nº 0008693</p>
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
app.get("/admin/clients", (req, res) => {
  const data = loadData();
  res.json(data.clients);
});

app.post("/admin/clients", (req, res) => {
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

app.put("/admin/clients/:id", (req, res) => {
  const data = loadData();
  const idx = data.clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  data.clients[idx] = { ...data.clients[idx], ...req.body };
  saveData(data);
  res.json({ success: true, client: data.clients[idx] });
});

app.delete("/admin/clients/:id", (req, res) => {
  const data = loadData();
  data.clients = data.clients.filter(c => c.id !== req.params.id);
  saveData(data);
  res.json({ success: true });
});

// ─────────────────────────────────────────────
// PROCESSOS
// ─────────────────────────────────────────────
app.put("/admin/clients/:clientId/processes/:processId/step", (req, res) => {
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

app.post("/admin/clients/:clientId/processes", (req, res) => {
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
app.post("/admin/clients/:clientId/processes/:processId/upload-windows", (req, res) => {
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

app.delete("/admin/clients/:clientId/processes/:processId/upload-windows/:windowId", (req, res) => {
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
app.get("/client/me", (req, res) => {
  const { email } = req.query;
  const data = loadData();
  const client = data.clients.find(c => c.email === email);
  if (!client) return res.status(404).json({ success: false });
  const { passwordHash, ...safeClient } = client;
  res.json(safeClient);
});

// ─────────────────────────────────────────────
// UPLOAD DE DOCUMENTOS (portal novo)
// ─────────────────────────────────────────────
app.post("/upload", upload.array("files", 10), async (req, res) => {
  const { clientEmail, clientName, processNumber } = req.body;
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
app.get("/admin/export", (req, res) => {
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
