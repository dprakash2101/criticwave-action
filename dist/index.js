"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const form_data_1 = __importDefault(require("form-data"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
async function wakeUpApi(apiUrl) {
    core.info('⚡️ Waking up the Review API...');
    try {
        const wakeupResponse = await (0, node_fetch_1.default)(apiUrl + '/api/WakeUp', {
            method: 'GET',
            headers: {
                accept: '*/*',
            },
        });
        if (!wakeupResponse.ok) {
            core.warning(`WakeUp API responded with status ${wakeupResponse.status}`);
        }
        else {
            core.info('WakeUp API is ready!');
        }
    }
    catch (error) {
        core.warning(`WakeUp API call failed: ${error.message}`);
    }
}
function beautifyReview(reviews) {
    if (!reviews || reviews.length === 0)
        return 'No issues found by CriticWave.';
    let output = '### 🤖 CriticWave PR Review:\n\n';
    for (const r of reviews) {
        output += `---\n**Issue Type:** ${r.issueType}\n`;
        output += `**File:** \`${r.fileName}:${r.lineNumber}\`\n`;
        output += `**Severity:** ${r.severity}\n`;
        output += `**Description:** ${r.description}\n`;
        output += `**Suggested Fix:** ${r.suggestedFix}\n`;
        output += '```csharp\n' + r.codeSnippet + '\n```\n\n';
    }
    return output;
}
async function run() {
    try {
        core.startGroup("🚀 Starting CriticWave PR Review");
        // Inputs
        const token = core.getInput('token', { required: true });
        const geminiApiKey = core.getInput('geminiApiKey', { required: true });
        const model = core.getInput('model') || 'gemini-2.0-flash';
        const styleGuide = core.getInput('styleGuide', { required: true });
        // Env vars for your API secrets
        const REVIEW_API_URL = process.env.REVIEW_API_URL;
        const AUTHORIZATION_HEADER = process.env.AUTHORIZATION_HEADER;
        if (!REVIEW_API_URL || !AUTHORIZATION_HEADER) {
            throw new Error('❌ REVIEW_API_URL and AUTHORIZATION_HEADER environment variables must be set');
        }
        const context = github.context;
        const pr = context.payload.pull_request;
        if (!pr)
            throw new Error('❌ This action only works on pull_request events.');
        const octokit = github.getOctokit(token);
        const { owner, repo } = context.repo;
        const prNumber = pr.number;
        // Wake up your API
        await wakeUpApi(REVIEW_API_URL);
        core.info(`🔍 Fetching PR diff for PR #${prNumber}...`);
        // Get raw diff text as string
        const diffResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner,
            repo,
            pull_number: prNumber,
            headers: {
                accept: 'application/vnd.github.v3.diff'
            }
        });
        // diffResponse.data is string containing the diff
        const diff = diffResponse.data;
        const tmpDir = fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), 'criticwave-'));
        const diffPath = path_1.default.join(tmpDir, 'diff.patch');
        fs_1.default.writeFileSync(diffPath, diff, 'utf-8');
        core.info(`📁 Diff saved at ${diffPath}`);
        // Get list of changed files in the PR
        core.info("📄 Fetching changed files...");
        const changedFiles = [];
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
            if (filesResponse.data.length === 0)
                break;
            for (const file of filesResponse.data) {
                changedFiles.push(file.filename);
            }
            if (filesResponse.data.length < perPage)
                break;
            page++;
        }
        core.info(`📝 Found ${changedFiles.length} changed files.`);
        // Download changed files content at PR head commit
        const contextFilePaths = [];
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
                const safeFileName = filename.replace(/[\\/]/g, '_'); // sanitize
                const filePath = path_1.default.join(tmpDir, safeFileName);
                fs_1.default.writeFileSync(filePath, buffer);
                contextFilePaths.push(filePath);
                core.info(`✔️ Downloaded ${filename}`);
            }
            catch (e) {
                core.warning(`⚠️ Could not download ${filename}: ${e.message}`);
            }
        }
        // Prepare form data for your API request
        const form = new form_data_1.default();
        form.append('PRNumber', prNumber.toString());
        form.append('StyleGuide', styleGuide);
        form.append('Diff', fs_1.default.createReadStream(diffPath));
        for (const contextFilePath of contextFilePaths) {
            form.append('ContextFiles', fs_1.default.createReadStream(contextFilePath));
        }
        core.info(`📡 Sending review request to API: ${REVIEW_API_URL}?model=${model}`);
        const response = await (0, node_fetch_1.default)(`${REVIEW_API_URL}/v1/beta/review?model=${model}`, {
            method: 'POST',
            headers: {
                'GeminiApiKey': geminiApiKey,
                'Authorization': AUTHORIZATION_HEADER
            },
            body: form
        });
        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status} ${response.statusText}`);
        }
        const result = await response.json();
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
    }
    catch (error) {
        core.setFailed(`❌ Action failed: ${error.message}`);
    }
}
run();
