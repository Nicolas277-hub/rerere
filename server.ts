import express, { Request, Response } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize Gemini client lazily to avoid crashing on startup if key is missing
let aiClient: GoogleGenAI | null = null;

function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// Health check endpoint
app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 1. Coach IA Endpoint
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { messages, workouts, history } = req.body;
    
    const client = getAiClient();
    
    // Construct system instructions with state context
    const systemInstruction = `Você é o Coach IA do RepFlow, um personal trainer virtual de elite altamente focado, prático e motivador.
O aplicativo RepFlow é focado estritamente em: Abrir -> Treinar -> Salvar a evolução.
Sem poluição, sem contagem de calorias, sem enrolação.

Treinos Cadastrados Atualmente:
${JSON.stringify(workouts, null, 2)}

Histórico Recente de Treino:
${JSON.stringify(history, null, 2)}

Diretrizes para respostas:
1. Responda em Português.
2. Seja objetivo, claro, direto ao ponto e motivador. Evite textos excessivamente longos.
3. Explique os "porquês" científicos de forma simples e de fácil absorção.
4. Se o usuário expressar incômodo físico ou dor (ex: dor no ombro), sugira de forma segura a substituição de exercícios ou redução de carga, e SEMPRE recomende consultar um médico se a dor persistir.
5. Se o usuário pedir para alterar o treino, sugira as alterações que façam sentido e explique-as, informando que ele pode atualizar o treino usando o comando ou usando a interface do editor de treinos. Nunca altere nada diretamente sem que ele execute a ação de atualização.`;

    // Convert messages to Gemini format
    // In @google/genai chat/generateContent, we can construct contents or start a chat
    // Let's pass contents with system instruction in config
    const geminiContents = messages.map((m: any) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const response = await client.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: geminiContents,
      config: {
        systemInstruction,
        temperature: 0.7,
      },
    });

    const text = response.text || 'Desculpe, não consegui formular uma resposta no momento.';
    res.json({ content: text });
  } catch (error: any) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ error: error.message || 'Erro ao processar conversa com o Coach IA.' });
  }
});

// 2. Import Workout with IA Endpoint
app.post('/api/import', async (req: Request, res: Response) => {
  try {
    const { text } = req.body;
    if (!text || text.trim() === '') {
      res.status(400).json({ error: 'Texto para importação está vazio.' });
      return;
    }

    const client = getAiClient();

    const systemInstruction = `Você é um especialista em educação física e análise de dados.
Sua missão é extrair treinos descritos em texto livre, fotos ou anotações e formatá-los em um JSON estruturado e válido.
Se houver múltiplos treinos ou divisões (como Treino A, Treino B, Upper/Lower, ABC), separe-os como treinos diferentes no array de retorno.
Se os detalhes de descanso ou observações não estiverem explícitos, faça uma suposição educada padrão (ex: descanso de 60 a 90 segundos).
Tente mapear os grupos musculares principais (ex: Peito, Costas, Ombro, Pernas, Bíceps, Tríceps) para cada exercício encontrado.`;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        workouts: {
          type: Type.ARRAY,
          description: 'Lista de treinos detectados no texto livre',
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING, description: 'Nome do treino, ex: Treino A - Peito' },
              exercises: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    name: { type: Type.STRING, description: 'Nome do exercício' },
                    setsCount: { type: Type.INTEGER, description: 'Número de séries, ex: 3 ou 4' },
                    repsRange: { type: Type.STRING, description: 'Faixa de repetições, ex: "8-10", "12", "6-8"' },
                    restTime: { type: Type.INTEGER, description: 'Tempo de descanso recomendado em segundos, ex: 90' },
                    notes: { type: Type.STRING, description: 'Observações ou instruções específicas, ou vazio se não houver' },
                    primaryMuscle: { type: Type.STRING, description: 'Grupo muscular principal (Peito, Costas, Ombro, Pernas, Bíceps, Tríceps)' },
                  },
                  required: ['name', 'setsCount', 'repsRange', 'restTime', 'primaryMuscle'],
                },
              },
            },
            required: ['name', 'exercises'],
          },
        },
      },
      required: ['workouts'],
    };

    const response = await client.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: `Analise o seguinte texto de treino e extraia de forma estruturada:\n\n${text}`,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema,
        temperature: 0.2,
      },
    });

    const parsedJson = JSON.parse(response.text || '{}');
    res.json(parsedJson);
  } catch (error: any) {
    console.error('Error in /api/import:', error);
    res.status(500).json({ error: error.message || 'Erro ao importar treino.' });
  }
});

// 3. Update Workout with IA Endpoint (Calculates changes / structural updates)
app.post('/api/update-ai', async (req: Request, res: Response) => {
  try {
    const { exercises, instruction } = req.body;
    
    const client = getAiClient();

    const systemInstruction = `Você é um robô de modificação de treinos inteligente e preciso.
Você recebe a lista atual de exercícios de um treino e um comando em linguagem natural do usuário solicitando alterações.
Você deve responder estritamente com o novo array completo de exercícios modificados conforme solicitado, além de um resumo de modificações (diff) explicando claramente o que foi adicionado, removido, editado ou reordenado.

Instruções para realizar as alterações:
- Se pediu para trocar/substituir um exercício: remova o antigo e insira o novo no mesmo lugar com configurações de séries/reps razoáveis se não especificadas.
- Se pediu para retirar/remover: delete o exercício.
- Se pediu para focar em costas, por exemplo: você pode adicionar ou aumentar séries dos exercícios de costas.
- Mantenha os IDs e dados intactos dos exercícios que NÃO mudaram para preservar o histórico. Para novos exercícios, gere um ID único (ex: string aleatória ou slug do nome).

Retorne exatamente um objeto JSON contendo:
- "newExercises": a nova lista de exercícios modificada.
- "diff": um objeto contendo arrays de strings descrevendo o que mudou ("added", "removed", "edited").`;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        newExercises: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              exerciseId: { type: Type.STRING },
              name: { type: Type.STRING },
              primaryMuscle: { type: Type.STRING },
              secondaryMuscle: { type: Type.STRING },
              setsCount: { type: Type.INTEGER },
              repsRange: { type: Type.STRING },
              restTime: { type: Type.INTEGER },
              notes: { type: Type.STRING },
              targetWeight: { type: Type.NUMBER },
            },
            required: ['id', 'name', 'primaryMuscle', 'setsCount', 'repsRange', 'restTime'],
          },
        },
        diff: {
          type: Type.OBJECT,
          properties: {
            added: { type: Type.ARRAY, items: { type: Type.STRING } },
            removed: { type: Type.ARRAY, items: { type: Type.STRING } },
            edited: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ['added', 'removed', 'edited'],
        },
      },
      required: ['newExercises', 'diff'],
    };

    const contentPrompt = `Exercícios atuais:\n${JSON.stringify(exercises, null, 2)}\n\nComando de atualização:\n"${instruction}"`;

    const response = await client.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: contentPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema,
        temperature: 0.1,
      },
    });

    const parsedJson = JSON.parse(response.text || '{}');
    res.json(parsedJson);
  } catch (error: any) {
    console.error('Error in /api/update-ai:', error);
    res.status(500).json({ error: error.message || 'Erro ao atualizar treino com IA.' });
  }
});

// Setup Vite middleware or Static Server
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[RepFlow Server] rodando em http://localhost:${PORT}`);
  });
}

startServer();
