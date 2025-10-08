import { Hono } from "hono";

type Env = {
  GITHUB_SECRET: string;
  GITHUB_TOKEN: string;
  GEMINI_API_KEY: string;
};

const app = new Hono<{ Bindings: Env }>();

async function verifyWebhookSignature(
  bodyText: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(bodyText)
  );

  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expected = `sha256=${hashHex}`;

  return signature === expected;
}

async function getPRFiles(
  owner: string,
  repo: string,
  prNumber: number,
  token: string
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`;
  console.log(`Fetching PR files from: ${url}`);
  console.log(`Token length: ${token.length}`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "GitHub-PR-Bot",
    },
  });

  console.log(`Response status: ${response.status}`);

  if (!response.ok) {
    const errorBody = await response.text();
    console.log(`Error response: ${errorBody}`);
    throw new Error(`Failed to fetch PR files: ${response.statusText}`);
  }

  return response.json();
}

async function getFileContent(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  token: string
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3.raw",
        "User-Agent": "GitHub-PR-Bot",
      },
    });

    if (!response.ok) return null;
    return response.text();
  } catch (error) {
    console.error("Error fetching file content:", error);
    return null;
  }
}

async function reviewCode(
  filename: string,
  patch: string,
  content: string | null,
  geminiKey: string
): Promise<string> {
  const prompt = `Review this code and provide specific line-by-line feedback:

File: ${filename}
Changes:
\`\`\`
${patch}
\`\`\`

${
  content
    ? `Full file:\n\`\`\`\n${content}\n\`\`\``
    : "Full content not available"
}

Provide feedback in this format:
- Line X: [Issue description and suggestion]
- Line Y: [Another issue and how to fix it]

Focus on: security issues, bugs, performance problems, best practices. If no issues, say "Looks good!"`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 1000,
        temperature: 0.3,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${error}`);
  }

  const data = (await response.json()) as any;
  console.log("Gemini API response:", JSON.stringify(data, null, 2));

  if (!data.candidates || !data.candidates[0]) {
    throw new Error("No candidates in Gemini response");
  }

  const candidate = data.candidates[0];

  if (candidate.finishReason === "MAX_TOKENS") {
    return "Code review completed but response was truncated due to length. The code appears to have multiple issues that need attention.";
  }

  if (
    candidate.content &&
    candidate.content.parts &&
    candidate.content.parts[0]
  ) {
    return candidate.content.parts[0].text;
  }

  return "Code review completed. Please check the code for potential issues.";
}

async function postPRComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  token: string
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "User-Agent": "GitHub-PR-Bot",
    },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    throw new Error(`Failed to post comment: ${response.statusText}`);
  }

  return response.json();
}

function parseLineComments(
  review: string
): Array<{ line: number; comment: string }> {
  const lineComments: Array<{ line: number; comment: string }> = [];
  const lines = review.split("\n");

  for (const line of lines) {
    const match = line.match(/^- Line (\d+):\s*(.+)$/);
    if (match) {
      const lineNumber = parseInt(match[1]);
      const comment = match[2].trim();
      if (lineNumber > 0 && comment) {
        lineComments.push({ line: lineNumber, comment });
      }
    }
  }

  return lineComments;
}

async function postLineComment(
  owner: string,
  repo: string,
  prNumber: number,
  commitId: string,
  path: string,
  line: number,
  body: string,
  token: string
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      "User-Agent": "GitHub-PR-Bot",
    },
    body: JSON.stringify({
      body,
      commit_id: commitId,
      path,
      line,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to post line comment: ${response.statusText}`);
  }

  return response.json();
}

app.get("/health", (c) => {
  return c.json({ status: "ok", message: "Bot is running" });
});

app.post("/webhook", async (c) => {
  try {
    const bodyText = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    const event = c.req.header("x-github-event");

    const secret = c.env.GITHUB_SECRET;
    const githubToken = c.env.GITHUB_TOKEN;
    const geminiKey = c.env.GEMINI_API_KEY;

    console.log(`Received ${event} event`);

    if (!signature) {
      return c.json({ error: "No signature provided" }, 401);
    }

    const isValid = await verifyWebhookSignature(bodyText, signature, secret);
    if (!isValid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    console.log("Signature verified");

    if (event !== "pull_request") {
      return c.json({ message: "Event ignored" });
    }

    const payload = JSON.parse(bodyText) as any;
    const action = payload.action;

    if (!["opened", "synchronize"].includes(action)) {
      return c.json({ message: "Action ignored" });
    }

    const pr = payload.pull_request;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const prNumber = pr.number;

    console.log(`Reviewing PR #${prNumber} in ${owner}/${repo}`);

    const files = (await getPRFiles(
      owner,
      repo,
      prNumber,
      githubToken
    )) as any[];
    console.log(`Found ${files.length} files in PR`);

    if (files.length === 0) {
      return c.json({ message: "No files to review" });
    }

    const codeExtensions = [
      ".js",
      ".ts",
      ".jsx",
      ".tsx",
      ".py",
      ".java",
      ".go",
      ".rb",
      ".php",
      ".cs",
      ".cpp",
      ".c",
    ];

    for (const file of files) {
      if (file.status === "deleted") continue;

      const isCodeFile = codeExtensions.some((ext) =>
        file.filename.endsWith(ext)
      );
      if (!isCodeFile) continue;

      console.log(`Reviewing file: ${file.filename}`);

      try {
        const content = await getFileContent(
          owner,
          repo,
          pr.head.ref,
          file.filename,
          githubToken
        );
        const review = await reviewCode(
          file.filename,
          file.patch,
          content,
          geminiKey
        );

        if (!review.includes("Looks good")) {
          // Try to parse line-specific comments
          const lineComments = parseLineComments(review);

          if (lineComments.length > 0) {
            // Post line-specific comments
            for (const lineComment of lineComments) {
              try {
                await postLineComment(
                  owner,
                  repo,
                  prNumber,
                  pr.head.sha,
                  file.filename,
                  lineComment.line,
                  lineComment.comment,
                  githubToken
                );
                console.log(
                  `Posted line comment for ${file.filename}:${lineComment.line}`
                );
              } catch (error) {
                console.error(`Error posting line comment:`, error);
              }
            }
          } else {
            // Fallback to general comment
            const comment = `**Code Review: ${file.filename}**\n\n${review}`;
            await postPRComment(owner, repo, prNumber, comment, githubToken);
            console.log(`Posted general review for ${file.filename}`);
          }
        } else {
          console.log(`${file.filename} looks good, skipping comment`);
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`Error reviewing ${file.filename}:`, error);
      }
    }

    return c.json({
      message: "Review completed",
      pr_number: prNumber,
      files_reviewed: files.length,
    });
  } catch (error) {
    console.error("Error:", error);
    return c.json({ error: (error as Error).message }, 500);
  }
});

export default app;
