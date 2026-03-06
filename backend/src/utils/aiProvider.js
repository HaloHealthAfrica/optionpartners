/**
 * Multi-provider AI utility
 * Supports Gemini, OpenAI, Claude, LM Studio, Ollama, and other OpenAI-compatible APIs
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');

class AIProvider {
  /**
   * Generate a response from the configured AI provider
   * @param {string} prompt - The prompt to send
   * @param {Object} settings - Provider settings { provider, apiKey, apiUrl, modelName }
   * @returns {Promise<string>} Generated text response
   */
  static async generateResponse(prompt, settings) {
    const { provider, apiKey, apiUrl, modelName } = settings;

    console.log(`[AI_PROVIDER] Using provider: ${provider}, model: ${modelName}`);

    switch (provider) {
      case 'gemini':
        return this.generateGemini(prompt, apiKey, modelName);

      case 'openai':
        return this.generateOpenAI(prompt, apiKey, modelName, 'https://api.openai.com/v1');

      case 'claude':
        return this.generateClaude(prompt, apiKey, modelName);

      case 'lmstudio':
      case 'ollama':
      case 'local':
        return this.generateOpenAICompatible(prompt, apiKey, modelName, apiUrl);

      case 'perplexity':
        return this.generateOpenAI(prompt, apiKey, modelName, 'https://api.perplexity.ai');

      default:
        // Default to OpenAI-compatible API
        return this.generateOpenAICompatible(prompt, apiKey, modelName, apiUrl);
    }
  }

  /**
   * Generate using Gemini API
   */
  static async generateGemini(prompt, apiKey, modelName = 'gemini-1.5-flash') {
    if (!apiKey) {
      throw new Error('Gemini API key not configured');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      console.error('[AI_PROVIDER] Gemini error:', error.message);
      throw new Error(`Gemini API error: ${error.message}`);
    }
  }

  /**
   * Generate using OpenAI API
   */
  static async generateOpenAI(prompt, apiKey, modelName = 'gpt-4o-mini', baseUrl = 'https://api.openai.com/v1') {
    if (!apiKey) {
      throw new Error('OpenAI API key not configured');
    }

    return this.generateOpenAICompatible(prompt, apiKey, modelName, baseUrl);
  }

  /**
   * Generate using Claude/Anthropic API
   */
  static async generateClaude(prompt, apiKey, modelName = 'claude-3-5-haiku-20241022') {
    if (!apiKey) {
      throw new Error('Anthropic API key not configured');
    }

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2024-10-22'
        },
        body: JSON.stringify({
          model: modelName,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      return data.content[0].text;
    } catch (error) {
      console.error('[AI_PROVIDER] Claude error:', error.message);
      throw new Error(`Claude API error: ${error.message}`);
    }
  }

  /**
   * Generate using OpenAI-compatible API (LM Studio, Ollama, etc.)
   */
  static async generateOpenAICompatible(prompt, apiKey, modelName, apiUrl) {
    const url = `${apiUrl}/chat/completions`;

    console.log(`[AI_PROVIDER] Calling OpenAI-compatible API at: ${url}`);

    const headers = {
      'Content-Type': 'application/json'
    };

    // Only add Authorization header if API key is provided
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    try {
      // Determine token parameter based on API target
      // OpenAI API uses max_completion_tokens; local/other APIs may still use max_tokens
      const isOpenAIAPI = apiUrl && apiUrl.includes('api.openai.com');

      // Reasoning models (o1, o3, gpt-5-nano, etc.) need higher token limits
      // because reasoning tokens count toward max_completion_tokens but don't produce visible output
      const isReasoningModel = /^(o\d|gpt-5-nano)/i.test(modelName);
      const tokenLimit = isReasoningModel ? 16384 : 4096;

      const tokenParam = isOpenAIAPI
        ? { max_completion_tokens: tokenLimit }
        : { max_tokens: 4096 };

      // Reasoning models don't support custom temperature
      const supportsTemperature = !isReasoningModel;

      const body = {
        model: modelName,
        messages: [
          {
            role: 'system',
            content: 'You are a professional trading performance analyst helping traders improve their performance.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        ...tokenParam,
        ...(supportsTemperature && { temperature: 0.7 })
      };

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        let errorMessage = `HTTP ${response.status}`;
        try {
          const error = await response.json();
          errorMessage = error.error?.message || error.message || errorMessage;
        } catch (e) {
          // Response might not be JSON
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();

      console.log('[AI_PROVIDER] Response structure:', JSON.stringify(data, null, 2).substring(0, 1000));

      if (!data.choices || data.choices.length === 0) {
        throw new Error('No response generated');
      }

      // Try standard content field first, then check alternative response formats
      const choice = data.choices[0];
      const content = choice.message?.content
        || choice.text
        || choice.message?.refusal;

      // Some models return content in the top-level output field
      const finalContent = content || data.output_text || data.output;

      if (!finalContent) {
        console.error('[AI_PROVIDER] Empty content. Full response:', JSON.stringify(data).substring(0, 2000));
        throw new Error('AI returned empty response');
      }

      return finalContent;
    } catch (error) {
      console.error('[AI_PROVIDER] OpenAI-compatible API error:', error.message);

      // Provide helpful error for connection issues
      if (error.code === 'ECONNREFUSED') {
        throw new Error(`Cannot connect to AI provider at ${apiUrl}. Make sure LM Studio/Ollama is running.`);
      }

      throw new Error(`AI Provider error: ${error.message}`);
    }
  }

  /**
   * Generate a streaming response — writes chunks to an Express SSE response.
   * @param {string} prompt
   * @param {Object} settings - { provider, apiKey, apiUrl, modelName }
   * @param {import('express').Response} res - Express response configured for SSE
   * @returns {Promise<string>} Full concatenated response
   */
  static async generateStreamingResponse(prompt, settings, res) {
    const { provider, apiKey, modelName } = settings;

    switch (provider) {
      case 'openai':
        return this.streamOpenAI(prompt, apiKey, modelName, 'https://api.openai.com/v1', res);
      case 'claude':
        return this.streamClaude(prompt, apiKey, modelName, res);
      case 'gemini':
        return this.streamGemini(prompt, apiKey, modelName, res);
      case 'lmstudio':
      case 'ollama':
      case 'local':
        return this.streamOpenAI(prompt, apiKey, modelName, settings.apiUrl, res);
      case 'perplexity':
        return this.streamOpenAI(prompt, apiKey, modelName, 'https://api.perplexity.ai', res);
      default:
        return this.streamOpenAI(prompt, apiKey, modelName, settings.apiUrl || 'https://api.openai.com/v1', res);
    }
  }

  /**
   * Stream via OpenAI-compatible API (OpenAI, LM Studio, Ollama, Perplexity).
   */
  static async streamOpenAI(prompt, apiKey, modelName, baseUrl, res) {
    const url = `${baseUrl}/chat/completions`;
    const isReasoningModel = /^(o\d|gpt-5-nano)/i.test(modelName);
    const isOpenAIAPI = baseUrl && baseUrl.includes('api.openai.com');
    const tokenLimit = isReasoningModel ? 16384 : 4096;
    const tokenParam = isOpenAIAPI
      ? { max_completion_tokens: tokenLimit }
      : { max_tokens: 4096 };

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const body = {
      model: modelName || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a professional trading performance analyst helping traders improve their performance.' },
        { role: 'user', content: prompt }
      ],
      stream: true,
      ...tokenParam,
      ...(!isReasoningModel && { temperature: 0.7 }),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      try { const e = await response.json(); msg = e.error?.message || msg; } catch {}
      throw new Error(msg);
    }

    let fullText = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            fullText += content;
            res.write(`data: ${JSON.stringify({ chunk: content })}\n\n`);
          }
        } catch {}
      }
    }

    return fullText;
  }

  /**
   * Stream via Anthropic Claude API.
   */
  static async streamClaude(prompt, apiKey, modelName, res) {
    if (!apiKey) throw new Error('Anthropic API key not configured');

    const model = modelName || 'claude-3-5-haiku-20241022';
    console.log(`[AI_PROVIDER] Streaming Claude: model=${model}`);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2024-10-22',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        stream: true,
        system: 'You are a professional trading performance analyst helping traders improve their performance.',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      let msg = `HTTP ${response.status}`;
      try {
        const e = await response.json();
        msg = e.error?.message || JSON.stringify(e.error) || msg;
      } catch {}
      console.error(`[AI_PROVIDER] Claude streaming error: ${msg}`);
      throw new Error(`Claude API error: ${msg}`);
    }

    let fullText = '';
    let chunkCount = 0;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        try {
          const parsed = JSON.parse(trimmed.slice(6));
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            fullText += parsed.delta.text;
            chunkCount++;
            res.write(`data: ${JSON.stringify({ chunk: parsed.delta.text })}\n\n`);
          }
        } catch {}
      }
    }

    console.log(`[AI_PROVIDER] Claude stream done: ${chunkCount} chunks, ${fullText.length} chars`);
    return fullText;
  }

  /**
   * Stream via Gemini API (uses generateContentStream).
   */
  static async streamGemini(prompt, apiKey, modelName, res) {
    if (!apiKey) throw new Error('Gemini API key not configured');

    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName || 'gemini-1.5-flash' });

    const streamResult = await model.generateContentStream(prompt);
    let fullText = '';

    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) {
        fullText += text;
        res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
      }
    }

    return fullText;
  }

  /**
   * Check if provider is configured correctly
   */
  static isConfigured(settings) {
    const { provider, apiKey, apiUrl } = settings;

    // Local providers don't require API key
    const localProviders = ['lmstudio', 'ollama', 'local'];
    if (localProviders.includes(provider)) {
      return !!apiUrl;
    }

    return !!apiKey;
  }
}

module.exports = AIProvider;
