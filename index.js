const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const {
  MercadoPagoConfig,
  Preference,
  Payment,
} = require('mercadopago');

const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();

app.use(cors());
app.use(express.json());

const client = new MercadoPagoConfig({
  accessToken: 'APP_USR-2194662847991440-052019-c788b33acd445c562d14cda1183fdf03-3416957178',
});

const PLANOS = {
  mensal: {
    nome: 'REINO FLIX PREMIUM - 1 MÊS',
    valor: 19.90,
    meses: 1,
    dias: 30,
  },

  semestral: {
    nome: 'REINO FLIX PREMIUM - 6 MESES',
    valor: 99.99,
    meses: 6,
    dias: 180,
  },

  anual: {
    nome: 'REINO FLIX PREMIUM - 12 MESES',
    valor: 199.99,
    meses: 12,
    dias: 365,
  },
};

function calcularValidadeDias(dias) {
  const data = new Date();
  data.setDate(data.getDate() + dias);
  return data;
}

function lerExternalReference(valor) {
  try {
    return JSON.parse(valor);
  } catch (error) {
    return null;
  }
}

app.get('/', (req, res) => {
  res.send('REINO FLIX BACKEND ONLINE');
});

app.post('/criar-pagamento', async (req, res) => {
  try {
    const { uid, plano } = req.body;

    if (!uid) {
      return res.status(400).json({
        erro: true,
        mensagem: 'UID do usuário é obrigatório',
      });
    }

    if (!PLANOS[plano]) {
      return res.status(400).json({
        erro: true,
        mensagem: 'Plano inválido',
      });
    }

    const planoSelecionado = PLANOS[plano];

    const pagamentoRef = await db.collection('pagamentos').add({
      uid,
      plano,
      status: 'criado',
      valor: planoSelecionado.valor,
      meses: planoSelecionado.meses,
      dias: planoSelecionado.dias,
      criadoEm: new Date(),
      origem: 'checkout-pro',
    });

    const preference = new Preference(client);

    const response = await preference.create({
      body: {
        items: [
          {
            title: planoSelecionado.nome,
            quantity: 1,
            currency_id: 'BRL',
            unit_price: planoSelecionado.valor,
          },
        ],

        external_reference: JSON.stringify({
          uid,
          plano,
          pagamentoId: pagamentoRef.id,
        }),

        notification_url: 'https://reino-flix-backend.onrender.com',

        back_urls: {
          success: 'https://google.com',
          failure: 'https://google.com',
          pending: 'https://google.com',
        },

        auto_return: 'approved',
      },
    });

    await pagamentoRef.update({
      preferenceId: response.id || null,
      initPointCriado: true,
    });

    res.json({
      init_point: response.init_point,
      pagamentoId: pagamentoRef.id,
    });

  } catch (error) {
    console.log(error);

    res.status(500).json({
      erro: true,
      mensagem: 'Erro ao criar pagamento',
    });
  }
});

app.post('/webhook', async (req, res) => {
  try {
    console.log('======================');
    console.log('WEBHOOK RECEBIDO');
    console.log(req.body);
    console.log('======================');

    const tipo = req.body.type || req.body.topic;
    const pagamentoMercadoPagoId =
      req.body.data?.id ||
      req.body.id;

    if (tipo !== 'payment' || !pagamentoMercadoPagoId) {
      console.log('Webhook ignorado. Tipo:', tipo);
      return res.status(200).json({
        ok: true,
        mensagem: 'Webhook ignorado',
      });
    }

    const payment = new Payment(client);

    const pagamentoMP = await payment.get({
      id: pagamentoMercadoPagoId,
    });

    console.log('PAGAMENTO CONSULTADO:');
    console.log({
      id: pagamentoMP.id,
      status: pagamentoMP.status,
      external_reference: pagamentoMP.external_reference,
      transaction_amount: pagamentoMP.transaction_amount,
    });

    if (pagamentoMP.status !== 'approved') {
      console.log('Pagamento ainda não aprovado:', pagamentoMP.status);

      return res.status(200).json({
        ok: true,
        status: pagamentoMP.status,
      });
    }

    const dadosReferencia = lerExternalReference(
      pagamentoMP.external_reference
    );

    if (!dadosReferencia || !dadosReferencia.uid || !dadosReferencia.plano) {
      console.log('External reference inválido.');

      return res.status(400).json({
        ok: false,
        mensagem: 'External reference inválido',
      });
    }

    const { uid, plano, pagamentoId } = dadosReferencia;

    if (!PLANOS[plano]) {
      return res.status(400).json({
        ok: false,
        mensagem: 'Plano inválido',
      });
    }

    const planoSelecionado = PLANOS[plano];

    const premiumInicio = new Date();
    const premiumExpiraEm = calcularValidadeDias(
      planoSelecionado.dias
    );

    await db.collection('usuarios').doc(uid).set({
      premium: true,
      premiumAtivo: true,

      planoPremium: plano,
      premiumMeses: planoSelecionado.meses,
      premiumDias: planoSelecionado.dias,

      premiumInicio,
      premiumExpiraEm,

      dataPagamento: premiumInicio,
      mercadoPagoPaymentId: String(pagamentoMP.id),
    }, { merge: true });

    const dadosPagamento = {
      uid,
      plano,
      status: 'aprovado',
      valor: planoSelecionado.valor,
      valorPago: pagamentoMP.transaction_amount || null,
      meses: planoSelecionado.meses,
      dias: planoSelecionado.dias,
      aprovadoEm: premiumInicio,
      premiumExpiraEm,
      mercadoPagoPaymentId: String(pagamentoMP.id),
      mercadoPagoStatus: pagamentoMP.status,
      origem: 'webhook-mercado-pago',
    };

    if (pagamentoId) {
      await db.collection('pagamentos').doc(pagamentoId).set(
        dadosPagamento,
        { merge: true }
      );
    } else {
      await db.collection('pagamentos').add(dadosPagamento);
    }

    console.log('PREMIUM LIBERADO PARA:', uid);
    console.log('PLANO:', plano);
    console.log('DIAS:', planoSelecionado.dias);
    console.log('EXPIRA EM:', premiumExpiraEm);

    res.status(200).json({
      ok: true,
      mensagem: 'Premium liberado',
      uid,
      plano,
      dias: planoSelecionado.dias,
      premiumExpiraEm,
    });

  } catch (error) {
    console.log('ERRO NO WEBHOOK:');
    console.log(error);

    res.status(500).json({
      ok: false,
    });
  }
});

app.listen(3000, () => {
  console.log('SERVIDOR ONLINE');
});