const axios = require("axios");

function parseRepo(url) {
  const match = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/
  );

  if (!match) return null;

  return {
    owner: match[1],
    repo: match[2]
  };
}

async function validateRepository(repoUrl) {
  const parsed = parseRepo(repoUrl);

  if (!parsed) {
    return {
      valid: false,
      message: "Invalid GitHub repository URL."
    };
  }

  try {
    const response = await axios.get(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`,
      {
        headers: {
          Accept: "application/vnd.github+json"
        }
      }
    );

    const repo = response.data;

    if (repo.private) {
      return {
        valid: false,
        message: "Repository is private. Please make it public before submitting."
      };
    }

    if (repo.archived) {
      return {
        valid: false,
        message: "Archived repositories cannot be submitted."
      };
    }

    if (repo.size === 0) {
      return {
        valid: false,
        message: "Repository is empty."
      };
    }

    return {
      valid: true,
      owner: parsed.owner,
      repo: parsed.repo,
      defaultBranch: repo.default_branch
    };

  } catch (err) {
    return {
      valid: false,
      message: "Repository not found."
    };
  }
}

module.exports = { validateRepository };