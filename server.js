const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const SibApiV3Sdk = require("sib-api-v3-sdk");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

// -----------------------------
//  BREVO CONFIG
// -----------------------------
let defaultClient = SibApiV3Sdk.ApiClient.instance;
let apiKey = defaultClient.authentications["api-key"];
apiKey.apiKey = process.env.BREVO_API_KEY;
const brevo = new SibApiV3Sdk.TransactionalEmailsApi();

// -----------------------------
//  SUPABASE CONFIG
// -----------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// -----------------------------
//  ADMIN — Gerar link
// -----------------------------
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

// -----------------------------
//  ADMIN — Listar links
// -----------------------------
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

// -----------------------------
//  VALIDAR TOKEN
// -----------------------------
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

// -----------------------------
//  ROTA LEADS (existente)
// -----------------------------
app.post("/send-email", async (req, res) => {
  try {
    const { nome, email, telefone, horario, valorCredito, prazo, carencia, tipoCredito, tipoTaxa, rendimentoLiquido, dsti } = req.body;

    // ── Email interno para a FinMais ──
    const htmlInterno = `
      <h2>Novo pedido de simulação</h2>
      <p><strong>Nome:</strong> ${nome}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Telefone:</strong> ${telefone}</p>
      <p><strong>Horário preferencial de contacto:</strong> ${horario || "Qualquer hora"}</p>
      <p><strong>Tipo de Crédito:</strong> ${tipoCredito || "Aquisição"}</p>
      <p><strong>Valor do Crédito:</strong> ${valorCredito}</p>
      <p><strong>Prazo:</strong> ${prazo}</p>
      ${carencia ? `<p><strong>Carência de capital:</strong> ${carencia}</p>` : ""}
      <p><strong>Tipo de Taxa:</strong> ${tipoTaxa}</p>
      ${rendimentoLiquido ? `<p><strong>Rendimento Líquido Mensal:</strong> ${rendimentoLiquido}</p>` : ""}
      ${dsti ? `<p><strong>Taxa de Esforço (DSTI):</strong> ${dsti}</p>` : ""}
    `;
    await brevo.sendTransacEmail({
      sender: { name: "FinMais", email: "geral@finmais.pt" },
      to: [{ email: "geral@finmais.pt" }],
      subject: "Novo pedido de simulação",
      htmlContent: htmlInterno
    });

    // ── Email de confirmação ao cliente ──
    const horarioTexto = horario && horario !== "qualquer"
      ? ", preferencialmente <strong>" + horario + "</strong>"
      : "";
    const htmlCliente = `
      <div style="font-family:Arial,sans-serif; max-width:560px; margin:0 auto; color:#333;">
        <h2 style="color:#A19276;">Recebemos o seu pedido!</h2>
        <p>Olá <strong>${nome}</strong>,</p>
        <p>Obrigado pelo seu contacto. Recebemos a sua simulação e entraremos em contacto consigo em breve${horarioTexto}.</p>
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <h3 style="color:#A19276;">Resumo da sua simulação</h3>
        <p><strong>Valor do crédito:</strong> ${valorCredito}</p>
        <p><strong>Tipo de crédito:</strong> ${tipoCredito || "Aquisição"}</p>
        <p><strong>Prazo:</strong> ${prazo}</p>
        ${carencia ? `<p><strong>Carência de capital:</strong> ${carencia}</p>` : ""}
        <p><strong>Tipo de Taxa:</strong> ${tipoTaxa}</p>
        ${rendimentoLiquido ? `<p><strong>Rendimento Líquido Mensal:</strong> ${rendimentoLiquido}</p>` : ""}
        ${dsti ? `<p><strong>Taxa de Esforço (DSTI):</strong> ${dsti}</p>` : ""}
        <hr style="border:none; border-top:1px solid #eee; margin:20px 0;" />
        <p style="font-size:12px; color:#999;">Esta é uma simulação meramente indicativa, sujeita a análise e aprovação bancária. A FinMais não garante as condições apresentadas.</p>
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

// -----------------------------
//  ROTA DOCUMENTOS (existente)
// -----------------------------
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
      to: [{ email: "geral@finmais.pt" }],
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

// -----------------------------
//  SERVIDOR
// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));