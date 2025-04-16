// GitHub Activity API & Zip Tree API handler
// This worker runs daily at 3am to process top active repositories
// and stores their details, README, and file tree structure
import { DBConfig, DORM, createClient } from "dormroom/DORM";
export { DORM };
import { env } from "cloudflare:workers";
const TOP_REPOS_COUNT = 500;

const dbConfig: DBConfig = {
  /** Put your CREATE TABLE queries here */
  statements: [
    `
    CREATE TABLE IF NOT EXISTS repositories (
        repo_full_name TEXT PRIMARY KEY,
        details_json TEXT,
        readme TEXT,
        tree TEXT,
        popular_date TEXT,
        updated_at TEXT
      )
    `,
  ],
  /** Updating this if you have breaking schema changes. */
  version: "v2",
  // Optional: used for authenticating requests
  authSecret: (env as any).ZIPTREE_SECRET,
};

console.log("ziptree secret", (env as any).ZIPTREE_SECRET);

interface Env {
  // Secrets & bindings
  ZIPTREE_SECRET: string;
  GITHUB_TOKEN: string;
  POPULAR_REPOS: Queue;
  REPOS_DB: DurableObjectNamespace;
  REPOS_KV: KVNamespace;
}

interface QueueMessage {
  repoFullName?: string;
  aggregate?: boolean;
  date: string; // YYYY-MM-DD
  position?: number;
}

// Main worker handler
export default {
  // Handle scheduled events
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (event.cron === "0 3 * * *") {
      await processTopRepositories(env, ctx);
    }
  },

  // Handle HTTP requests
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const acceptHeader = request.headers.get("Accept") || "";
    const wantsMarkdown =
      !acceptHeader.includes("text/html") || url.pathname === "/index.md";

    const client = createClient(env.REPOS_DB, dbConfig);

    // First try to handle the request with the middleware
    const middlewareResponse = await client.middleware(request, {
      prefix: "/admin",
      secret: dbConfig.authSecret,
    });

    // If middleware handled the request, return its response
    if (middlewareResponse) {
      return middlewareResponse;
    }

    if (
      url.pathname === "/trigger" &&
      url.searchParams.get("secret") === env.ZIPTREE_SECRET
    ) {
      await processTopRepositories(env, ctx);
      return new Response("triggered");
    }

    // if (
    //   url.pathname === "/clear" &&
    //   url.searchParams.get("secret") === env.ZIPTREE_SECRET
    // ) {
    //   const date = url.searchParams.get("date") || getPreviousDay();
    //   const result = await queryState(
    //     { env },
    //     "DELETE FROM repositories WHERE popular_date = ?",
    //     date,
    //   );

    //   return new Response(
    //     JSON.stringify({
    //       success: result.ok,
    //       message: result.ok
    //         ? "Cleared repositories"
    //         : "Failed to clear repositories",
    //     }),
    //   );
    // }

    if (
      url.pathname === "/aggregate" &&
      url.searchParams.get("secret") === env.ZIPTREE_SECRET
    ) {
      return await processAggregateTask(
        url.searchParams.get("date") || getPreviousDay(),
        env,
        ctx,
      );
    }

    // Return markdown format if requested or Accept header doesn't include text/html
    if (wantsMarkdown) {
      const latestData = await env.REPOS_KV.get("latest");

      if (latestData) {
        const data = JSON.parse(latestData);
        const markdownContent = generateMarkdownList(data);

        return new Response(markdownContent, {
          headers: {
            "Content-Type": "text/markdown;charset=utf8",
            "Cache-Control": "max-age=3600",
          },
        });
      }

      return new Response(
        "# No data available\n\nSorry, no repository data is currently available.",
        {
          status: 404,
          headers: {
            "Content-Type": "text/markdown",
          },
        },
      );
    }
    // Return the latest aggregated data
    if (url.pathname === "/index.json") {
      const latestData = await env.REPOS_KV.get("latest");

      if (latestData) {
        return new Response(latestData, {
          headers: {
            "Content-Type": "application/json;charset=utf8",
            "Cache-Control": "max-age=3600",
          },
        });
      }

      return new Response(JSON.stringify({ error: "No data available" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  // Handle queue messages
  async queue(batch: MessageBatch<QueueMessage>, env: Env, ctx: any) {
    const client = createClient(env.REPOS_DB, dbConfig);

    for (const message of batch.messages) {
      const data = message.body;

      // Process aggregate task
      if (data.aggregate) {
        await processAggregateTask(data.date, env, ctx);
        continue;
      }

      const { repoFullName, date } = data;
      // Process individual repository task
      if (repoFullName) {
        try {
          console.log(
            `Processing repository: ${repoFullName} for date ${date}`,
          );

          // Fetch repository details from GitHub API
          const repoDetails = await fetchRepositoryDetails(
            repoFullName,
            //  env.GITHUB_TOKEN,
          );
          if (!repoDetails) {
            console.log("No details; give up");
            return;
          }

          // Fetch repository README
          const readme = await fetchRepositoryReadme(
            repoFullName,
            repoDetails.default_branch,
            env.GITHUB_TOKEN,
            50 * 1024,
          );

          // Fetch repository file tree structure
          const fileTreeUrl = await fetchRepositoryFileTree(
            repoFullName,
            env.ZIPTREE_SECRET,
          );

          // Use the queryState utility to store data

          const result = await client.query(
            `INSERT OR REPLACE INTO repositories 
             (repo_full_name, details_json, readme, tree, popular_date, updated_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`,
            undefined,
            repoFullName,
            JSON.stringify(repoDetails),
            readme,
            fileTreeUrl,
            date,
          );

          if (!result.ok) {
            console.error(
              `Failed to store data for ${repoFullName}: ${JSON.stringify(
                result,
              )}`,
            );
          }
        } catch (error) {
          console.error(`Error processing repository ${repoFullName}:`, error);
        }
      }
    }
  },
};

// Generate markdown list from repository data
function generateMarkdownList(data: any): string {
  let markdown = `# Top ${data.count} GitHub Repositories\n\n`;
  markdown += `Date: ${data.date}\n\n`;

  if (!data.repositories || data.repositories.length === 0) {
    return markdown + "No repositories found for this period.";
  }

  data.repositories.forEach((repo: any, index: number) => {
    const stars = repo.stargazers_count.toLocaleString();
    const language = repo.language ? `[${repo.language}]` : "";

    markdown += `- **${repo.name}** - ${
      repo.description || "No description"
    } ${language} (⭐ ${stars})\n`;
  });

  return markdown;
}
// Get previous day's date in YYYY-MM-DD format
function getPreviousDay(): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date.toISOString().split("T")[0]; // YYYY-MM-DD
}

const getTopRepos = async (date: string) => {
  const [year, month, day] = date.split("-");

  // Fetch GitHub activity data for repositories from the previous day
  const apiUrl = `https://activity-data.forgithub.com/merge/${year}/${month}/${day}/starred.json`;
  const response = await fetch(apiUrl);
  if (!response.ok) {
    console.log({ apiUrl });
    console.error(`Failed to fetch repo data: ${response.status}`);
    return;
  }

  const data: { count: { [id: string]: number } } = await response.json();

  // Sort repositories by activity count and take top 100
  const topRepos = Object.entries(data.count)
    .sort(([, countA], [, countB]) => (countB as number) - (countA as number))
    .slice(0, TOP_REPOS_COUNT)
    .map(([repoName, count], index) => ({
      body: {
        repoFullName: repoName,
        date,
        count,
        position: index + 1,
      },
    }));
  return topRepos;
};

// Process top repositories from GitHub activity data
async function processTopRepositories(
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  try {
    const date = getPreviousDay();

    const topRepos = await getTopRepos(date);
    if (!topRepos) {
      return;
    }

    // Process repositories in batches of 100
    const batches = [];
    for (let i = 0; i < topRepos.length; i += 100) {
      batches.push(topRepos.slice(i, i + 100));
    }

    // Send batches to queue
    for (const batch of batches) {
      await env.POPULAR_REPOS.sendBatch(batch);
    }

    // Add final aggregate task to queue
    await env.POPULAR_REPOS.send({
      aggregate: true,
      date,
    });

    console.log(`Queued ${topRepos.length} repositories for processing`);
  } catch (error) {
    console.error("Error processing top repositories:", error);
  }
}

async function processAggregateTask(
  date: string,
  env: Env,
  ctx: any,
): Promise<Response> {
  try {
    console.log(`Processing aggregate task for date: ${date}`);

    const client = createClient(env.REPOS_DB, dbConfig);
    // Use the queryState utility to get repository data
    const result = await client.query(
      `SELECT repo_full_name, details_json, popular_date, readme, tree
       FROM repositories
       WHERE popular_date = ?
       LIMIT ${TOP_REPOS_COUNT}`,
      undefined,
      date,
    );

    if (!result.ok) {
      const msg = `Failed to aggregate data for ${date}: ${JSON.stringify(
        result,
      )}`;
      console.error(msg);
      return new Response(msg, { status: result.status });
    }

    // Process the results and create the aggregated data
    const repositories = result.json?.map((row: any) => {
      // Parse the indexed columns based on the result structure
      const { repo_full_name, details_json, popular_date, readme, tree } = row;

      return {
        name: repo_full_name,
        ...JSON.parse(details_json),
        tree,
        readme: readme,
      };
    });

    const aggregatedData = JSON.stringify(
      {
        date: date,
        repositories: repositories,
        count: repositories?.length,
      },
      undefined,
      2,
    );

    const tooLarge = aggregatedData.length > 25 * 1024 * 1024;
    if (tooLarge) {
      return new Response("This data is too large for KV (over 25MB)", {
        status: 429,
      });
    }

    // Store aggregated data in KV
    ctx.waitUntil(env.REPOS_KV.put("latest", aggregatedData));

    return new Response(aggregatedData, {
      headers: { "Content-Type": "application/json;charset=utf8" },
    });
  } catch (error: any) {
    console.error(`Error processing aggregate task for ${date}:`, error);
    return new Response("Error aggregation;" + error.message, { status: 500 });
  }
}

// Fetch repository details from GitHub API
async function fetchRepositoryDetails(repoFullName: string): Promise<any> {
  try {
    const response = await fetch(
      `https://cache.forgithub.com/${repoFullName}/details`,
    );

    if (!response.ok) {
      console.error(
        `Failed to fetch details for ${repoFullName}: ${response.status}`,
      );
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error(
      `Error fetching repository details for ${repoFullName}:`,
      error,
    );
    return null;
  }
}

// Fetch repository README from GitHub
async function fetchRepositoryReadme(
  repoFullName: string,
  default_branch: string,
  githubToken: string,
  maxSize: number,
): Promise<string | null> {
  try {
    const url = `https://raw.githubusercontent.com/${repoFullName}/refs/heads/${default_branch}/README.md`;
    // First try to get README metadata
    const metaResponse = await fetch(url, {
      headers: {
        Authorization: `token ${githubToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "CloudflareWorker",
      },
    });

    if (!metaResponse.ok) {
      console.error(
        `No README found for ${repoFullName}: ${metaResponse.status}`,
      );
      return null;
    }

    const readme: string = await metaResponse.text();

    const suffix = "/n\nREADME TRUNCATED (>50kb)";
    const shortReadme =
      readme && readme.length > maxSize
        ? readme?.slice(0, maxSize - suffix.length) + suffix
        : readme;

    return shortReadme;
  } catch (error) {
    console.error(`Error fetching README for ${repoFullName}:`, error);
    return null;
  }
}

// Fetch repository file tree structure using ZipTree API
async function fetchRepositoryFileTree(
  repoFullName: string,
  ziptreeSecret: string,
): Promise<string | null> {
  try {
    const [owner, repo] = repoFullName.split("/");
    const zipUrl = encodeURIComponent(
      `https://github.com/${owner}/${repo}/archive/HEAD.zip`,
    );

    const url = `https://ziptree.uithub.com/tree/${zipUrl}?type=token-tree`;

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${btoa(ziptreeSecret)}`,
      },
    });

    if (!response.ok) {
      console.error(
        `Failed to fetch file tree for ${repoFullName}: ${response.status}`,
      );
      return null;
    }
    await response.text();

    return url;
  } catch (error) {
    console.error(`Error fetching file tree for ${repoFullName}:`, error);
    return null;
  }
}
