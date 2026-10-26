// =====================================================
//  WEISX PRO - Servidor (contas, planos e PIX)
// =====================================================
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const {
  MONGODB_URI,          // link do banco MongoDB Atlas
  JWT_SECRET,           // uma senha grande e aleatória só sua
  MP_ACCESS_TOKEN,      // Access Token de PRODUÇÃO do Mercado Pago
  PUBLIC_URL,           // ex: https://weisx-pro-backend.onrender.com
  PORT = 3000,
} = process.env;

// ---------- PLANOS (mude os preços no Render, sem mexer no código) ----------
// PRECO_TESTE = 0 deixa o teste de 1 dia grátis (só 1 vez por conta)
const PLANOS = {
  teste:  { nome: 'Teste 1 dia', dias: 1,  preco: Number(process.env.PRECO_TESTE ?? 0)  },
  dias15: { nome: '15 dias',     dias: 15, preco: Number(process.env.PRECO_15    ?? 15) },
  dias30: { nome: '30 dias',     dias: 30, preco: Number(process.env.PRECO_30    ?? 25) },
};

// ---------- BANCO DE DADOS ----------
const Usuario = mongoose.model('Usuario', new mongoose.Schema({
  usuario:   { type: String, required: true, unique: true, lowercase: true, trim: true },
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  senhaHash: { type: String, required: true },
  acessoAte: { type: Date, default: null },
  usouTeste: { type: Boolean, default: false },
  criadoEm:  { type: Date, default: Date.now },
}));

const Pagamento = mongoose.model('Pagamento', new mongoose.Schema({
  mpId:      { type: String, required: true, unique: true },
  usuarioId: { type: mongoose.Schema.Types.ObjectId, required: true },
  plano:     { type: String, required: true },
  valor:     Number,
  status:    { type: String, default: 'pending' },
  creditado: { type: Boolean, default: false },
  criadoEm:  { type: Date, default: Date.now },
}));

// ---------- FUNÇÕES ----------
const DIA = 24 * 60 * 60 * 1000;

function gerarToken(u) {
  // Token dura 1 ano e é renovado toda vez que o app abre = login "pra sempre"
  return jwt.sign({ id: u._id.toString() }, JWT_SECRET, { expiresIn: '365d' });
}

function resumo(u) {
  const agora = Date.now();
  const ativo = !!u.acessoAte && u.acessoAte.getTime() > agora;
  return {
    usuario: u.usuario,
    email: u.email,
    acessoAte: u.acessoAte,
    ativo,
    diasRestantes: ativo ? Math.ceil((u.acessoAte.getTime() - agora) / DIA) : 0,
    usouTeste: u.usouTeste,
  };
}

// Se ainda tem dias, soma em cima. Se venceu, conta a partir de agora.
function liberar(u, dias) {
  const base = u.acessoAte && u.acessoAte.getTime() > Date.now() ? u.acessoAte.getTime() : Date.now();
  u.acessoAte = new Date(base + dias * DIA);
}

async function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const { id } = jwt.verify(token, JWT_SECRET);
    req.user = await Usuario.findById(id);
    if (!req.user) throw new Error();
    next();
  } catch {
    res.status(401).json({ erro: 'Sessão expirada. Faça login de novo.' });
  }
}

async function verificarPagamento(mpId) {
  const pag = await Pagamento.findOne({ mpId: String(mpId) });
  if (!pag || pag.creditado) return pag;

  const r = await fetch(`https://api.mercadopago.com/v1/payments/${mpId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });
  if (!r.ok) return pag;
  const mp = await r.json();
  pag.status = mp.status;

  if (mp.status === 'approved') {
    // Trava pra nunca creditar o mesmo pagamento 2 vezes
    const travado = await Pagamento.findOneAndUpdate(
      { mpId: pag.mpId, creditado: false },
      { creditado: true, status: 'approved' },
      { new: true }
    );
    if (travado) {
      const u = await Usuario.findById(pag.usuarioId);
      if (u) {
        liberar(u, PLANOS[pag.plano].dias);
        if (pag.plano === 'teste') u.usouTeste = true;
        await u.save();
      }
      return travado;
    }
  } else {
    await pag.save();
  }
  return pag;
}

// ---------- ROTAS ----------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('WEISX PRO online'));

app.post('/cadastro', async (req, res) => {
  const usuario = String(req.body.usuario || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');

  if (!/^[a-z0-9_.]{3,20}$/.test(usuario))
    return res.status(400).json({ erro: 'Usuário: 3 a 20 letras/números, sem espaço.' });
  if (!/^\S+@\S+\.\S+$/.test(email))
    return res.status(400).json({ erro: 'E-mail inválido.' });
  if (senha.length < 6)
    return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' });

  if (await Usuario.findOne({ usuario })) return res.status(409).json({ erro: 'Esse usuário
