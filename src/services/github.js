import crypto from 'crypto';
import { config } from '../config/env.js';

// GitHub App authentication using JWT
export class GitHubApp {
  constructor() {
    this.appId = config.github?.appId;
    this.privateKey = config.github?.privateKey;
    this.webhookSecret = config.github?.webhookSecret;
    this.baseUrl = 'https://api.github.com';
  }

  // Generate JWT for GitHub App authentication
  generateJWT() {
    if (!this.appId || !this.privateKey) {
      throw new Error('GitHub App not configured');
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60, // Issued 60 seconds ago to account for clock drift
      exp: now + 600, // Expires in 10 minutes
      iss: this.appId,
    };

    // Create JWT manually (simplified, in production use jsonwebtoken library)
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(`${header}.${body}`)
      .sign(this.privateKey, 'base64url');

    return `${header}.${body}.${signature}`;
  }

  // Get installation access token for a specific installation
  async getInstallationToken(installationId) {
    const jwt = this.generateJWT();

    const response = await fetch(
      `${this.baseUrl}/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get installation token: ${error}`);
    }

    const data = await response.json();
    return data.token;
  }

  // Verify webhook signature
  verifyWebhookSignature(payload, signature) {
    if (!this.webhookSecret) {
      return false;
    }

    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', this.webhookSecret)
      .update(payload)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }
}

// GitHub operations for a specific repository
export class GitHubRepo {
  constructor(token, owner, repo) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.baseUrl = 'https://api.github.com';
  }

  async request(method, endpoint, body = null) {
    const url = `${this.baseUrl}${endpoint}`;
    const options = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error: ${response.status} - ${error}`);
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  // Get repository info
  async getRepo() {
    return this.request('GET', `/repos/${this.owner}/${this.repo}`);
  }

  // Get default branch
  async getDefaultBranch() {
    const repo = await this.getRepo();
    return repo.default_branch;
  }

  // Get a reference (branch)
  async getRef(ref) {
    return this.request('GET', `/repos/${this.owner}/${this.repo}/git/refs/heads/${ref}`);
  }

  // Create a new branch from a base branch
  async createBranch(branchName, baseBranch = null) {
    const base = baseBranch || await this.getDefaultBranch();
    const baseRef = await this.getRef(base);

    return this.request('POST', `/repos/${this.owner}/${this.repo}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha: baseRef.object.sha,
    });
  }

  // Get file content
  async getFileContent(path, branch = null) {
    const ref = branch || await this.getDefaultBranch();
    try {
      const response = await this.request(
        'GET',
        `/repos/${this.owner}/${this.repo}/contents/${path}?ref=${ref}`
      );
      return {
        content: Buffer.from(response.content, 'base64').toString('utf-8'),
        sha: response.sha,
      };
    } catch (error) {
      if (error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  // Create or update a file
  async createOrUpdateFile(path, content, message, branch, existingSha = null) {
    const body = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
    };

    if (existingSha) {
      body.sha = existingSha;
    }

    return this.request('PUT', `/repos/${this.owner}/${this.repo}/contents/${path}`, body);
  }

  // Delete a file
  async deleteFile(path, message, branch, sha) {
    return this.request('DELETE', `/repos/${this.owner}/${this.repo}/contents/${path}`, {
      message,
      sha,
      branch,
    });
  }

  // Create a commit with multiple file changes
  async createCommit(message, changes, branch, authorName, authorEmail) {
    // Get the current commit SHA for the branch
    const ref = await this.getRef(branch);
    const currentCommitSha = ref.object.sha;

    // Get the tree SHA from the current commit
    const currentCommit = await this.request(
      'GET',
      `/repos/${this.owner}/${this.repo}/git/commits/${currentCommitSha}`
    );
    const baseTreeSha = currentCommit.tree.sha;

    // Create tree entries for each change
    const treeEntries = [];
    for (const change of changes) {
      if (change.action === 'delete') {
        treeEntries.push({
          path: change.path,
          mode: '100644',
          type: 'blob',
          sha: null, // null SHA deletes the file
        });
      } else {
        // Create a blob for the content
        const blob = await this.request(
          'POST',
          `/repos/${this.owner}/${this.repo}/git/blobs`,
          {
            content: change.content,
            encoding: 'utf-8',
          }
        );

        treeEntries.push({
          path: change.path,
          mode: '100644',
          type: 'blob',
          sha: blob.sha,
        });
      }
    }

    // Create the tree
    const newTree = await this.request(
      'POST',
      `/repos/${this.owner}/${this.repo}/git/trees`,
      {
        base_tree: baseTreeSha,
        tree: treeEntries,
      }
    );

    // Create the commit
    const newCommit = await this.request(
      'POST',
      `/repos/${this.owner}/${this.repo}/git/commits`,
      {
        message,
        tree: newTree.sha,
        parents: [currentCommitSha],
        author: {
          name: authorName,
          email: authorEmail,
          date: new Date().toISOString(),
        },
      }
    );

    // Update the branch reference
    await this.request(
      'PATCH',
      `/repos/${this.owner}/${this.repo}/git/refs/heads/${branch}`,
      {
        sha: newCommit.sha,
        force: false,
      }
    );

    return newCommit;
  }

  // Create a pull request
  async createPullRequest(title, body, head, base = null) {
    const baseBranch = base || await this.getDefaultBranch();

    return this.request('POST', `/repos/${this.owner}/${this.repo}/pulls`, {
      title,
      body,
      head,
      base: baseBranch,
    });
  }

  // Get a pull request
  async getPullRequest(number) {
    return this.request('GET', `/repos/${this.owner}/${this.repo}/pulls/${number}`);
  }

  // Merge a pull request
  async mergePullRequest(number, commitTitle, mergeMethod = 'squash') {
    return this.request('PUT', `/repos/${this.owner}/${this.repo}/pulls/${number}/merge`, {
      commit_title: commitTitle,
      merge_method: mergeMethod,
    });
  }

  // Close a pull request
  async closePullRequest(number) {
    return this.request('PATCH', `/repos/${this.owner}/${this.repo}/pulls/${number}`, {
      state: 'closed',
    });
  }

  // Add a comment to a pull request
  async addPullRequestComment(number, body) {
    return this.request('POST', `/repos/${this.owner}/${this.repo}/issues/${number}/comments`, {
      body,
    });
  }

  // Get pull request reviews
  async getPullRequestReviews(number) {
    return this.request('GET', `/repos/${this.owner}/${this.repo}/pulls/${number}/reviews`);
  }
}

// Service for managing GitHub integration with Forges
export class ForgeGitHubService {
  constructor(db) {
    this.db = db;
    this.app = new GitHubApp();
  }

  // Get GitHub repo instance for a forge
  async getRepoForForge(forgeId) {
    const result = await this.db.query(
      `SELECT github_repo, github_app_installation_id FROM forges WHERE id = $1`,
      [forgeId]
    );

    if (result.rows.length === 0) {
      throw new Error('Forge not found');
    }

    const forge = result.rows[0];
    if (!forge.github_repo || !forge.github_app_installation_id) {
      throw new Error('Forge not linked to GitHub');
    }

    const [owner, repo] = forge.github_repo.split('/');
    const token = await this.app.getInstallationToken(forge.github_app_installation_id);

    return new GitHubRepo(token, owner, repo);
  }

  // Create a branch and PR for a patch
  async createPatchPR(patchId) {
    const patchResult = await this.db.query(
      `SELECT p.*, f.github_repo, f.github_app_installation_id,
              a.name as author_name
       FROM patches p
       JOIN forges f ON f.id = p.forge_id
       JOIN agents a ON a.id = p.author_id
       WHERE p.id = $1`,
      [patchId]
    );

    if (patchResult.rows.length === 0) {
      throw new Error('Patch not found');
    }

    const patch = patchResult.rows[0];

    if (!patch.github_repo || !patch.github_app_installation_id) {
      throw new Error('Forge not linked to GitHub');
    }

    const [owner, repo] = patch.github_repo.split('/');
    const token = await this.app.getInstallationToken(patch.github_app_installation_id);
    const ghRepo = new GitHubRepo(token, owner, repo);

    // Create branch name
    const branchName = `bothub/patch-${patchId.slice(0, 8)}-${this.slugify(patch.title)}`;

    // Create the branch
    await ghRepo.createBranch(branchName);

    // Apply changes
    const changes = typeof patch.changes === 'string'
      ? JSON.parse(patch.changes)
      : patch.changes;

    // Create commit with all changes
    const commitMessage = `${patch.title}

${patch.description || ''}

Co-authored-by: ${patch.author_name} <${patch.author_name}@bothub.dev>
BotHub-Patch: ${patchId}`;

    await ghRepo.createCommit(
      commitMessage,
      changes,
      branchName,
      'BotHub',
      'bot@bothub.dev'
    );

    // Create pull request
    const prBody = `## BotHub Patch

**Author:** ${patch.author_name}
**Patch ID:** ${patchId}

${patch.description || ''}

---
*This PR was created automatically by BotHub.*
[View on BotHub](https://bothub.dev/patches/${patchId})`;

    const pr = await ghRepo.createPullRequest(
      patch.title,
      prBody,
      branchName
    );

    // Update patch with GitHub info
    await this.db.query(
      `UPDATE patches SET github_branch = $1, github_pr_url = $2 WHERE id = $3`,
      [branchName, pr.html_url, patchId]
    );

    return pr;
  }

  // Merge a patch's PR
  async mergePatchPR(patchId) {
    const patchResult = await this.db.query(
      `SELECT p.*, f.github_repo, f.github_app_installation_id
       FROM patches p
       JOIN forges f ON f.id = p.forge_id
       WHERE p.id = $1`,
      [patchId]
    );

    if (patchResult.rows.length === 0) {
      throw new Error('Patch not found');
    }

    const patch = patchResult.rows[0];

    if (!patch.github_pr_url) {
      throw new Error('Patch has no associated PR');
    }

    const [owner, repo] = patch.github_repo.split('/');
    const token = await this.app.getInstallationToken(patch.github_app_installation_id);
    const ghRepo = new GitHubRepo(token, owner, repo);

    // Extract PR number from URL
    const prNumber = parseInt(patch.github_pr_url.split('/').pop());

    // Merge the PR
    await ghRepo.mergePullRequest(prNumber, `Merge patch: ${patch.title}`);

    // Update patch status
    await this.db.query(
      `UPDATE patches SET status = 'merged' WHERE id = $1`,
      [patchId]
    );

    return { success: true };
  }

  // Close a patch's PR without merging
  async closePatchPR(patchId) {
    const patchResult = await this.db.query(
      `SELECT p.*, f.github_repo, f.github_app_installation_id
       FROM patches p
       JOIN forges f ON f.id = p.forge_id
       WHERE p.id = $1`,
      [patchId]
    );

    if (patchResult.rows.length === 0) {
      throw new Error('Patch not found');
    }

    const patch = patchResult.rows[0];

    if (!patch.github_pr_url) {
      throw new Error('Patch has no associated PR');
    }

    const [owner, repo] = patch.github_repo.split('/');
    const token = await this.app.getInstallationToken(patch.github_app_installation_id);
    const ghRepo = new GitHubRepo(token, owner, repo);

    // Extract PR number from URL
    const prNumber = parseInt(patch.github_pr_url.split('/').pop());

    // Close the PR
    await ghRepo.closePullRequest(prNumber);

    // Update patch status
    await this.db.query(
      `UPDATE patches SET status = 'closed' WHERE id = $1`,
      [patchId]
    );

    return { success: true };
  }

  // Sync review comments from BotHub to GitHub PR
  async syncReviewsToGitHub(patchId) {
    const patchResult = await this.db.query(
      `SELECT p.*, f.github_repo, f.github_app_installation_id
       FROM patches p
       JOIN forges f ON f.id = p.forge_id
       WHERE p.id = $1`,
      [patchId]
    );

    if (patchResult.rows.length === 0) {
      throw new Error('Patch not found');
    }

    const patch = patchResult.rows[0];

    if (!patch.github_pr_url) {
      return; // No PR to sync to
    }

    const reviewsResult = await this.db.query(
      `SELECT pr.*, a.name as reviewer_name
       FROM patch_reviews pr
       JOIN agents a ON a.id = pr.reviewer_id
       WHERE pr.patch_id = $1`,
      [patchId]
    );

    const [owner, repo] = patch.github_repo.split('/');
    const token = await this.app.getInstallationToken(patch.github_app_installation_id);
    const ghRepo = new GitHubRepo(token, owner, repo);

    const prNumber = parseInt(patch.github_pr_url.split('/').pop());

    // Post a summary comment with all reviews
    let comment = '## BotHub Reviews\n\n';
    for (const review of reviewsResult.rows) {
      const emoji = review.verdict === 'approve' ? '✅' :
                    review.verdict === 'request_changes' ? '🔄' : '💬';
      comment += `### ${emoji} ${review.reviewer_name} - ${review.verdict}\n`;

      if (review.tested) {
        comment += '✓ Tested\n';
      }

      const comments = typeof review.comments === 'string'
        ? JSON.parse(review.comments)
        : review.comments;

      if (comments && comments.length > 0) {
        comment += '\n**Comments:**\n';
        for (const c of comments) {
          comment += `- \`${c.path}:${c.line}\`: ${c.body}\n`;
        }
      }
      comment += '\n---\n\n';
    }

    await ghRepo.addPullRequestComment(prNumber, comment);
  }

  // Helper to create URL-friendly slug
  slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  }
}

export const githubApp = new GitHubApp();
