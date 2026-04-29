import express from "express";
import cors from "cors";
import ExcelJS from "exceljs";
import nodemailer from "nodemailer";

const app = express();
const PORT = process.env.PORT || 3000;

// Permitir pedidos do teu widget
app.use(cors());
app.use(express.json());

// Rota simples para testar
app.get("/", (req, res) => {
  res.send("API de Crédito Habitação ativa");
});

// POST /api/calculate
app.post("/api/calculate", (req, res) => {
  try {
    const { valor, euribor, spread, meses } = req.body;

    const taxaAnual = euribor + spread;
    const i = taxaAnual / 100 / 12;

    const prestacao =
      (valor * i) / (1 - Math.pow(1 + i, -meses));

    const total = prestacao * meses;

    res.json({
      prestacao: prestacao.toFixed(2),
      total: total.toFixed(2)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro no cálculo" });
  }
});

// POST /api/schedule/export
app.post("/api/schedule/export", async (req, res) => {
  try {
    const { valor, taxa, meses } = req.body;

    const i = taxa / 100 / 12;
    const prestacao =
      (valor * i) / (1 - Math.pow(1 + i, -meses));

    let saldo = valor;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Plano Prestacional");

    sheet.columns = [
      { header: "Mês", key: "mes", width: 10 },
      { header: "Prestação (€)", key: "prestacao", width: 18 },
      { header: "Juros (€)", key: "juros", width: 15 },
      { header: "Capital (€)", key: "capital", width: 15 },
      { header: "Saldo (€)", key: "saldo", width: 15 }
    ];

    for (let mes = 1; mes <= meses; mes++) {
      const juros = saldo * i;
      const capital = prestacao - juros;
      saldo -= capital;

      sheet.addRow({
        mes,
        prestacao: prestacao.toFixed(2),
        juros: juros.toFixed(2),
        capital: capital.toFixed(2),
        saldo: saldo.toFixed(2)
      });
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=plano_prestacional.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao gerar Excel" });
  }
});

// POST /api/lead
app.post("/api/lead", async (req, res) => {
  const {
    clientId,
    nome,
    email,
    telefone,
    valor,
    prazo,
    taxa
  } = req.body;

  try {
    // Configurar transporte SMTP (Gmail, Outlook, etc.)
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 465,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    const destinatario = process.env.LEADS_TO || process.env.SMTP_USER;

    await transporter.sendMail({
      from: `"Simulador Crédito" <${process.env.SMTP_USER}>`,
      to: destinatario,
      subject: "Nova Lead de Crédito Habitação",
      html: `
        <h2>Nova Lead Recebida</h2>
        <p><strong>Cliente ID:</strong> ${clientId || "-"}</p>
        <p><strong>Nome:</strong> ${nome}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Telefone:</strong> ${telefone}</p>
        <p><strong>Valor pretendido:</strong> ${valor || "-"} €</p>
        <p><strong>Prazo (meses):</strong> ${prazo || "-"} </p>
        <p><strong>Taxa estimada:</strong> ${taxa || "-"} %</p>
      `
    });

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao enviar lead" });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
