import * as core from '@actions/core';
import * as github from '@actions/github';
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import os from 'os';

interface FixDetails {
  description: string;
  currentCode: string;
  suggestedFixCode: string;
}

interface ReviewItem {
  issueType: string;
  description: string;
  severity: string;
  lineNumber: number;
  fileName: string;
  fixDetails: FixDetails;
}

interface ReviewResponse {
  reviews: ReviewItem[];
}

async function wakeUpApi(apiUrl: string) {
  core.info('⚡️ Waking up the Review API...');
  try {
    const wakeupResponse = await fetch(apiUrl + '/api/WakeUp', {
      method: 'GET',
      headers: {
        accept: '*/*',
      },
    });
    if (!wakeupResponse.ok) {
      core.warning(`WakeUp API responded with status ${wakeupResponse.status}`);
    } else {
      core.info('WakeUp API is ready!');
    }
  } catch (error) {
    core.warning(`WakeUp API call failed: ${(error as Error).message}`);
  }
}

function beautifyReview(reviews: ReviewItem[]): string {
  if (!reviews || reviews.length === 0) {
    return '🎉 **No issues found by CriticWave!** The code looks clean and ready to go!';
  }

  // Map file extensions to Markdown code block language identifiers
  const languageMap: { [key: string]: string } = {
    '.cs': 'csharp',
    '.js': 'javascript',
    '.ts': 'typescript',
    '.py': 'python',
    '.java': 'java',
    '.go': 'go',
    '.rb': 'ruby',
    '.php': 'php',
    '.cpp': 'cpp',
    '.c': 'c',
    '.cshtml': 'html',
    '.html': 'html',
    '.css': 'css',
    '.json': 'json',
    '.xml': 'xml',
    '.sql': 'sql',
  };

  let output = '### 🤖 CriticWave PR Review\n\n';
  output += 'Below is the automated review of your pull request, highlighting potential improvements to make your code even better. Each issue includes a clear explanation and actionable suggestions.\n\n';

  reviews.forEach((r, index) => {
    // Determine the language based on file extension
    const extension = r.fileName.substring(r.fileName.lastIndexOf('.'))?.toLowerCase() || '';
    const language = languageMap[extension] || '';

    output += `#### Issue ${index + 1}: ${r.issueType}\n`;
    output += `**📍 Location:** \`${r.fileName}:${r.lineNumber}\`\n`;
    output += `**⚠️ Severity:** ${r.severity}\n`;
    output += `**🔍 Description:**\n${r.description}\n\n`;
    output += `**💡 Suggested Fix:**\n${r.fixDetails.description}\n\n`;
    output += `**📜 Current Code:**\n`;
    output += `\`\`\`${language}\n` + (r.fixDetails.currentCode || '// No code provided') + '\n```\n';
    output += `**✅ Proposed Fix:**\n`;
    output += `\`\`\`${language}\n` + (r.fixDetails.suggestedFixCode || '// No suggestion provided') + '\n```\n';
    output += '\n---\n\n';
  });

  output += 'Thanks for your contribution! Apply these suggestions to improve your code, or let us know if you have any questions! 🚀';
  return output;
}

async function run() {
  try {
    core.startGroup("🚀 Starting CriticWave PR Review");

    const token = core.getInput('github-token', { required: true });
    const geminiApiKey = core.getInput('gemini-api-key', { required: true });
    const model = core.getInput('model') || 'gemini-2.0-flash';
    const styleGuide = core.getInput('pr-style-guide', { required: true });
    const REVIEW_API_URL = "https://suggesstionsservice.onrender.com";

    const context = github.context;
    const pr = context.payload.pull_request;
    if (!pr) throw new Error('❌ This action only works on pull_request events.');

    const octokit = github.getOctokit(token);
    const { owner, repo } = context.repo;
    const prNumber = pr.number;

    await wakeUpApi(REVIEW_API_URL);

    core.info(`🔍 Fetching PR diff for PR #${prNumber}...`);
    const diffResponse = await octokit.request<string>('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber,
      headers: {
        accept: 'application/vnd.github.v3.diff'
      }
    });

    const diff = diffResponse.data;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'criticwave-'));
    const diffPath = path.join(tmpDir, 'diff.diff');
    fs.writeFileSync(diffPath, diff, 'utf-8');
    core.info(`📁 Diff saved at ${diffPath}`);

    core.info("📄 Fetching changed files...");
    const changedFiles: string[] = [];
    const perPage = 100;
    let page = 1;
    while (true) {
      const filesResponse = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
        per_page: perPage,
        page: page,
      });
      if (filesResponse.data.length === 0) break;
      for (const file of filesResponse.data) {
        changedFiles.push(file.filename);
      }
      if (filesResponse.data.length < perPage) break;
      page++;
    }
    core.info(`📝 Found ${changedFiles.length} changed files.`);

    const contextFilePaths: string[] = [];
    for (const filename of changedFiles) {
      try {
        const fileResponse = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: filename,
          ref: pr.head.sha
        });

        if (!('content' in fileResponse.data)) {
          core.warning(`⚠️ Skipping ${filename}, no content found.`);
          continue;
        }

        const contentBase64 = fileResponse.data.content;
        const buffer = Buffer.from(contentBase64, 'base64');
        const safeFileName = filename.replace(/[\\/]/g, '_');
        const filePath = path.join(tmpDir, safeFileName);
        fs.writeFileSync(filePath, buffer);
        contextFilePaths.push(filePath);
        core.info(`✔️ Downloaded ${filename}`);
      } catch (e) {
        core.warning(`⚠️ Could not download ${filename}: ${(e as Error).message}`);
      }
    }

    const form = new FormData();
    form.append('PRNumber', prNumber.toString());
    form.append('StyleGuide', styleGuide);
    form.append('Diff', fs.createReadStream(diffPath));
    for (const contextFilePath of contextFilePaths) {
      form.append('ContextFiles', fs.createReadStream(contextFilePath));
    }

    // Log form details
    core.info('🧪 Logging form data before sending request...');
    core.info(`➡️ REVIEW_API_URL: ${REVIEW_API_URL}`);
    core.info(`➡️ Model: ${model}`);
    core.info(`➡️ GeminiApiKey: ${geminiApiKey ? '✔️ Provided' : '❌ Missing'}`);
    core.info(`➡️ PRNumber: ${prNumber}`);
    core.info(`➡️ StyleGuide length: ${styleGuide.length}`);
    core.info(`➡️ Diff file exists: ${fs.existsSync(diffPath)}`);
    core.info(`➡️ Context file count: ${contextFilePaths.length}`);
    contextFilePaths.forEach((file, i) =>
      core.info(`📄 Context file ${i + 1}: ${file} (exists: ${fs.existsSync(file)})`)
    );
    core.info(`🧾 Form headers: ${JSON.stringify(form.getHeaders())}`);

    core.info(`📡 Sending review request to API: ${REVIEW_API_URL}/v1/beta/review?model=${model}`);

    const response = await fetch(`${REVIEW_API_URL}/v1/beta/review?model=${model}`, {
      method: 'POST',
      headers: {
        'GeminiApiKey': geminiApiKey,
        ...form.getHeaders(),
      },
      body: form
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`API request failed with status ${response.status} ${response.statusText}\n❗ Response body: ${body}`);
    }

    const result: ReviewResponse = await response.json();
    core.info("✅ Review received. Posting review as comment on PR...");

    const commentBody = beautifyReview(result.reviews);
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: commentBody
    });

    core.info("🎉 Review comment posted!");
    core.endGroup();
  } catch (error: any) {
    core.setFailed(`❌ Action failed: ${error.message}`);
  }
}

run();