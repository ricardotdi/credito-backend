const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const SibApiV3Sdk = require("sib-api-v3-sdk");
const app = express();
app.use(cors());
app.use(bodyParser.json());

// -----------------------------
//  BREVO CONFIG
// -----------------------------
let defaultClient = SibApiV3Sdk.ApiClient.instance;
let apiKey = defaultClient.authentications["api-key"];
apiKey.apiKey = process.env.BREVO_API_KEY; // <-- DEFINIDA NO RENDER

const brevo = new SibApiV3Sdk.TransactionalEmailsApi();

// -----------------------------
//  ROTA PARA RECEBER FORMULÁRIO
// -----------------------------
app.post("/send-email", async (req, res) => {
  try {
    const {
      nome,
      email,
      telefone,
      valorCredito,
      prazo,
      tipoTaxa
    } = req.body;

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
//  SERVIDOR
// -----------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
