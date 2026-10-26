import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVALS_DIR = path.resolve(process.cwd(), '.claude', 'evals');

/**
 * Ensure evals directory exists
 */
function ensureEvalsDir() {
  if (!fs.existsSync(EVALS_DIR)) {
    fs.mkdirSync(EVALS_DIR, { recursive: true });
  }
}

/**
 * Parse an eval definition markdown file
 */
export function parseEvalDefinition(content) {
  const evals = { capability: [], regression: [] };
  
  // Extract capability evals
  const capMatch = content.match(/### Capability Evals([\s\S]*?)(?:###|$)/);
  if (capMatch) {
    const lines = capMatch[1].split('\n');
    lines.forEach(line => {
      const match = line.match(/-\s*\[([ x])\]\s*(.+)/);
      if (match) {
        evals.capability.push({
          name: match[2].trim(),
          done: match[1] === 'x'
        });
      }
    });
  }
  
  // Extract regression evals
  const regMatch = content.match(/### Regression Evals([\s\S]*?)(?:###|$)/);
  if (regMatch) {
    const lines = regMatch[1].split('\n');
    lines.forEach(line => {
      const match = line.match(/-\s*\[([ x])\]\s*(.+)/);
      if (match) {
        evals.regression.push({
          name: match[2].trim(),
          done: match[1] === 'x'
        });
      }
    });
  }
  
  return evals;
}

import { spawn } from 'child_process';

/**
 * Run a code-based grader (shell command)
 */
export async function runCodeGrader(command, cwd = process.cwd()) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, timeout: 60000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', (code) => {
      resolve({ pass: code === 0, stdout, stderr, code });
    });
  });
}

/**
 * Run model-based grader (LLM as judge)
 */
export async function runModelGrader(prompt, modelClient, model) {
  const resp = await modelClient.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: 'You are an impartial evaluator. Score 1-5 with reasoning.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0,
    max_tokens: 500
  });
  const text = resp.choices[0].message.content;
  const scoreMatch = text.match(/Score:\s*(\d)/i);
  const score = scoreMatch ? parseInt(scoreMatch[1]) : 3;
  return { score, reasoning: text };
}

/**
 * Run all evals for a feature
 */
export async function runEvals(featureName, options = {}) {
  const { 
    modelClient, 
    model = 'openai/gpt-4o-mini',
    codeGraders = {},
    modelGraders = {}
  } = options;
  
  ensureEvalsDir();
  const evalFile = path.join(EVALS_DIR, `${featureName}.md`);
  
  if (!fs.existsSync(evalFile)) {
    return { error: `Eval file not found: ${evalFile}` };
  }
  
  const content = fs.readFileSync(evalFile, 'utf-8');
  const { capability, regression } = parseEvalDefinition(content);
  
  const results = {
    feature: featureName,
    timestamp: new Date().toISOString(),
    capability: { total: 0, passed: 0, failed: 0, details: [] },
    regression: { total: 0, passed: 0, failed: 0, details: [] }
  };
  
  // Run capability evals
  for (const evalItem of capability) {
    results.capability.total++;
    let passed = false;
    let detail = '';
    
    if (codeGraders[evalItem.name]) {
      const grader = codeGraders[evalItem.name];
      const res = await runCodeGrader(grader.command, grader.cwd);
      passed = res.pass;
      detail = res.pass ? 'PASS' : `FAIL: ${res.stderr || res.stdout}`;
    } else if (modelGraders[evalItem.name] && modelClient) {
      const grader = modelGraders[evalItem.name];
      const res = await runModelGrader(grader.prompt, modelClient, model);
      passed = res.score >= grader.threshold || 4;
      detail = `Score: ${res.score}/5 - ${res.reasoning}`;
    } else {
      detail = 'SKIP: No grader defined';
    }
    
    results.capability.details.push({ name: evalItem.name, passed, detail });
    if (passed) results.capability.passed++;
    else results.capability.failed++;
  }
  
  // Run regression evals
  for (const evalItem of regression) {
    results.regression.total++;
    let passed = false;
    let detail = '';
    
    if (codeGraders[evalItem.name]) {
      const grader = codeGraders[evalItem.name];
      const res = await runCodeGrader(grader.command, grader.cwd);
      passed = res.pass;
      detail = res.pass ? 'PASS' : `FAIL: ${res.stderr || res.stdout}`;
    } else if (modelGraders[evalItem.name] && modelClient) {
      const grader = modelGraders[evalItem.name];
      const res = await runModelGrader(grader.prompt, modelClient, model);
      passed = res.score >= grader.threshold || 4;
      detail = `Score: ${res.score}/5 - ${res.reasoning}`;
    } else {
      detail = 'SKIP: No grader defined';
    }
    
    results.regression.details.push({ name: evalItem.name, passed, detail });
    if (passed) results.regression.passed++;
    else results.regression.failed++;
  }
  
  // Calculate pass@k metrics
  const capPassAt1 = results.capability.total > 0 
    ? results.capability.details.filter(d => d.passed).length / results.capability.total 
    : 1;
  
  // Save run log
  const logFile = path.join(EVALS_DIR, `${featureName}.log`);
  const logEntry = `\n---\n## Run: ${results.timestamp}\n\n` +
    `Capability: ${results.capability.passed}/${results.capability.total} (pass@1: ${(capPassAt1 * 100).toFixed(0)}%)\n` +
    `Regression: ${results.regression.passed}/${results.regression.total}\n`;
  fs.appendFileSync(logFile, logEntry, 'utf-8');
  
  return results;
}

/**
 * Create eval definition template
 */
export function createEvalTemplate(featureName) {
  ensureEvalsDir();
  const content = `# EVAL DEFINITION: ${featureName}

## Capability Evals
- [ ] Capability 1: Description
- [ ] Capability 2: Description
- [ ] Capability 3: Description

## Regression Evals
- [ ] Regression 1: Description
- [ ] Regression 2: Description
- [ ] Regression 3: Description

## Success Metrics
- pass@3 > 90% for capability evals
- pass^3 = 100% for regression evals
`;
  const filePath = path.join(EVALS_DIR, `${featureName}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}