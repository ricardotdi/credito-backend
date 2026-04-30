const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const SibApiV3Sdk = require("sib-api-v3-sdk");
const app = express();
app.use(cors());

// Aumentar limite para suportar ficheiros em base64
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
//  ROTA LEADS (existente)
// -----------------------------
app.post("/send-email", async (req, res) => {
  try {
    const { nome, email, telefone, valorCredito, prazo, tipoTaxa } = req.body;

    const html = `
      <h2>Novo pedido de simulação</h2>
      <p><strong>Nome:</strong> ${nome}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Telefone:</strong> ${telefone}</p>
      <p><strong>Valor do Crédito:</strong> ${valorCredito}</p>
      <p><strong>Prazo:</strong> ${prazo}</p>
      <p><strong>Tipo de Taxa:</strong> ${tipoTaxa}</p>
    `;

    const emailData = {
      sender: { name: "FinMais", email: "geral@finmais.pt" },
      to: [{ email: "geral@finmais.pt" }],
      subject: "Novo pedido de simulação",
      htmlContent: html
    };

    const response = await brevo.sendTransacEmail(emailData);
    res.json({ success: true, brevoId: response.messageId });
  } catch (error) {
    console.error("Erro ao enviar email:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// -----------------------------
//  ROTA DOCUMENTOS (nova)
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

    const attachment = ficheiros.map(f => ({
      name: f.name,
      content: f.data
    }));

    const emailData = {
      sender: { name: "FinMais Portal", email: "geral@finmais.pt" },
      to: [{ email: "geral@finmais.pt" }],
      subject: `Documentos recebidos — ${clienteNome}`,
      htmlContent: html,
      attachment: attachment
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
app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
