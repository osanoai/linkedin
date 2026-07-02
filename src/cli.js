import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, setToken, logout, status, DEFAULT_SCOPES, DEFAULT_PORT } from './auth.js';
import { runPost } from './post.js';
import { resolveToken } from './config.js';
import { resolvePersonUrn } from './api.js';
import { UsageError, CliError, AuthError } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function version() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  return pkg.version;
}

const ROOT_HELP = `linkedin — post to LinkedIn from the command line

USAGE
  linkedin <command> [options]

COMMANDS
  auth login     Authenticate via LinkedIn OAuth 2.0 in your browser
  auth token     Store a manually generated access token (headless/agent friendly)
  auth status    Show whether you are authenticated (exit 0 = yes, 3 = no)
  auth logout    Delete stored credentials
  post           Create a LinkedIn post (text, article link, images, or video)
  whoami         Verify the current token against the LinkedIn API and print the member

GLOBAL OPTIONS
  -h, --help     Show help (works on every command, e.g. linkedin post --help)
  -V, --version  Print the CLI version

AUTHENTICATION (two ways)
  1. Browser OAuth:   linkedin auth login --client-id XXX --client-secret YYY
     Requires a LinkedIn Developer app (https://www.linkedin.com/developers/apps)
     with the "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect"
     products enabled, and http://localhost:${DEFAULT_PORT}/callback added as an
     authorized redirect URL.
  2. Direct token:    linkedin auth token <ACCESS_TOKEN>
     Paste a token from the Developer Portal token generator
     (https://www.linkedin.com/developers/tools/oauth/token-generator).
     Or skip storage entirely and set LINKEDIN_ACCESS_TOKEN in the environment.

ENVIRONMENT VARIABLES
  LINKEDIN_ACCESS_TOKEN     Access token; overrides stored credentials
  LINKEDIN_PERSON_URN       Author URN (urn:li:person:xxxx); skips profile lookup
  LINKEDIN_CLIENT_ID        OAuth app client id (for auth login)
  LINKEDIN_CLIENT_SECRET    OAuth app client secret (for auth login)
  LINKEDIN_CLI_CONFIG_DIR   Where credentials.json is stored
                            (default ~/.config/linkedin-cli)
  LINKEDIN_API_BASE         API base URL (default https://api.linkedin.com)
  LINKEDIN_OAUTH_BASE       OAuth base URL (default https://www.linkedin.com)

EXIT CODES
  0  success
  1  API or runtime error
  2  invalid usage (bad flags/arguments)
  3  not authenticated / token expired or rejected

EXAMPLES
  linkedin auth login --client-id abc --client-secret shh
  linkedin post "Hello LinkedIn!"
  linkedin post --text "Read this" --article https://example.com/blog
  linkedin post "Team offsite!" --image pic1.jpg --alt "Group photo" --image pic2.jpg
  linkedin post 'Shout-out to @[Jane Doe](urn:li:person:AbC_123) and @[Osano](urn:li:organization:17959845)!'
  linkedin post "For my network only" --visibility connections --json

Run \`linkedin <command> --help\` for detailed options.`;

const AUTH_HELP = `linkedin auth — manage LinkedIn credentials

USAGE
  linkedin auth login  [options]   Browser-based OAuth 2.0 flow
  linkedin auth token  <TOKEN> [--person-urn URN]
  linkedin auth status [--json]
  linkedin auth logout

auth login options
  --client-id <id>         LinkedIn app Client ID     (or LINKEDIN_CLIENT_ID)
  --client-secret <secret> LinkedIn app Client Secret (or LINKEDIN_CLIENT_SECRET)
  --port <n>               Loopback callback port (default ${DEFAULT_PORT}).
                           http://localhost:<port>/callback must be listed as an
                           authorized redirect URL in your LinkedIn app's Auth tab.
  --scopes "<scopes>"      Space-separated OAuth scopes
                           (default "${DEFAULT_SCOPES}")
  --timeout <seconds>      How long to wait for the browser callback (default 300)
  --no-browser             Print the authorization URL instead of opening a browser

auth token
  Stores an access token you obtained elsewhere (e.g. the Developer Portal token
  generator). The token is verified against /v2/userinfo (then /v2/me) to resolve
  your person URN. If the token has no profile scope, pass it explicitly:
    linkedin auth token <TOKEN> --person-urn urn:li:person:AbC_123

auth status
  Prints authentication state. Exit code 0 when authenticated, 3 when not.
  --json prints machine-readable output.

Credentials are stored with 0600 permissions in
$LINKEDIN_CLI_CONFIG_DIR/credentials.json (default ~/.config/linkedin-cli/).`;

const POST_HELP = `linkedin post — create a LinkedIn post as the authenticated member

USAGE
  linkedin post [TEXT] [options]

TEXT (required; choose one)
  TEXT positional argument   linkedin post "Hello world"
  -t, --text <text>          Same as positional
  --text-file <path>         Read post text from a file; use "-" for stdin
  Max length: 3000 characters (after mention resolution).

MENTIONS (inline, anywhere in the text)
  @[Display Name](urn:li:person:MEMBER_ID)        mention a member
  @[Company Name](urn:li:organization:ORG_ID)     mention a company/school
  The marker renders as "Display Name" and becomes a real linked mention.
  Note: LinkedIn does not provide a public API to look up an arbitrary member's
  URN by name — you must already know the URN (your own is shown by \`whoami\`).

MEDIA (optional; the three kinds are mutually exclusive)
  -i, --image <path>         Attach an image; repeat for multi-image posts (max 9)
      --alt <text>           Alt text / description for the most recent --image
      --image-title <text>   Title for the most recent --image
      --video <path>         Attach a single video (mp4 recommended)
      --video-title <text>   Title for the video
  -a, --article <url>        Share a link/article
      --article-title <text>        Custom title for the shared link
      --article-description <text>  Custom description for the shared link

OTHER OPTIONS
  --visibility <public|connections>  Who can see the post (default: public)
  --dry-run                  Build and print the API payload without uploading
                             or posting anything (no network calls)
  --json                     Print the result as JSON: {"urn": "...", "url": "..."}
  -h, --help                 Show this help

OUTPUT
  On success prints the new post URN and a URL of the form
  https://www.linkedin.com/feed/update/<urn>/ (exit code 0).

EXAMPLES
  # Plain text
  linkedin post "Shipping day! 🚀"

  # Text from stdin (useful for agents / scripts)
  echo "Generated update" | linkedin post --text-file -

  # Link share with custom title and description
  linkedin post "Our latest research:" \\
    --article https://example.com/report \\
    --article-title "2026 Privacy Report" \\
    --article-description "Key findings on consent trends."

  # Multi-image post with alt text, connections-only
  linkedin post "Highlights from the summit" \\
    --image day1.jpg --alt "Keynote stage" \\
    --image day2.jpg --alt "Panel discussion" \\
    --visibility connections

  # Video post
  linkedin post "Demo of the new feature" --video demo.mp4 --video-title "Feature demo"

  # Mentions
  linkedin post 'Great work by @[Jane Doe](urn:li:person:AbC_123) at @[Osano](urn:li:organization:17959845)!'

  # Inspect the payload without posting
  linkedin post "test" --image pic.png --dry-run`;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function takeValue(argv, i, flag) {
  if (i + 1 >= argv.length) throw new UsageError(`Missing value for ${flag}.`);
  return argv[i + 1];
}

async function parsePostArgs(argv) {
  const opts = {
    text: null,
    images: [],
    video: null,
    article: null,
    visibility: 'public',
    dryRun: false,
    json: false,
  };
  let textFile = null;
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        return { help: true };
      case '-t':
      case '--text':
        opts.text = takeValue(argv, i, arg);
        i++;
        break;
      case '--text-file':
        textFile = takeValue(argv, i, arg);
        i++;
        break;
      case '-i':
      case '--image':
        opts.images.push({ path: takeValue(argv, i, arg), alt: null, title: null });
        i++;
        break;
      case '--alt': {
        const val = takeValue(argv, i, arg);
        i++;
        const last = opts.images[opts.images.length - 1];
        if (!last) throw new UsageError('--alt must come after an --image flag.');
        last.alt = val;
        break;
      }
      case '--image-title': {
        const val = takeValue(argv, i, arg);
        i++;
        const last = opts.images[opts.images.length - 1];
        if (!last) throw new UsageError('--image-title must come after an --image flag.');
        last.title = val;
        break;
      }
      case '--video':
        if (opts.video) throw new UsageError('Only one --video is allowed per post.');
        opts.video = { path: takeValue(argv, i, arg), title: null };
        i++;
        break;
      case '--video-title':
        if (!opts.video) throw new UsageError('--video-title must come after --video.');
        opts.video.title = takeValue(argv, i, arg);
        i++;
        break;
      case '-a':
      case '--article':
        opts.article = { url: takeValue(argv, i, arg), title: null, description: null, ...(opts.article || {}) };
        opts.article.url = argv[i + 1];
        i++;
        break;
      case '--article-title':
        opts.article = opts.article || { url: null, title: null, description: null };
        opts.article.title = takeValue(argv, i, arg);
        i++;
        break;
      case '--article-description':
        opts.article = opts.article || { url: null, title: null, description: null };
        opts.article.description = takeValue(argv, i, arg);
        i++;
        break;
      case '--visibility':
        opts.visibility = takeValue(argv, i, arg);
        i++;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        if (arg.startsWith('-') && arg !== '-') throw new UsageError(`Unknown option for post: ${arg}`);
        positionals.push(arg);
    }
  }
  if (opts.article && !opts.article.url) {
    throw new UsageError('--article-title/--article-description require --article <url>.');
  }
  if (positionals.length > 1) {
    throw new UsageError('Multiple positional arguments given; quote your post text as a single argument.');
  }
  if (positionals.length === 1) {
    if (opts.text != null) throw new UsageError('Provide text either positionally or via --text, not both.');
    opts.text = positionals[0];
  }
  if (textFile != null) {
    if (opts.text != null) throw new UsageError('Provide text via --text/positional or --text-file, not both.');
    opts.text = textFile === '-' ? await readStdin() : fs.readFileSync(textFile, 'utf8');
    opts.text = opts.text.replace(/\n$/, '');
  }
  return { opts };
}

async function cmdPost(argv) {
  const parsed = await parsePostArgs(argv);
  if (parsed.help) {
    console.log(POST_HELP);
    return 0;
  }
  const result = await runPost(parsed.opts);
  if (result.dryRun) {
    if (parsed.opts.json) {
      console.log(JSON.stringify({ dry_run: true, would_upload: result.uploads, payload: result.payload }, null, 2));
    } else {
      console.log('Dry run — nothing was uploaded or posted.');
      if (result.uploads.length) console.log(`Would upload: ${result.uploads.join(', ')}`);
      console.log('UGC post payload:');
      console.log(JSON.stringify(result.payload, null, 2));
    }
    return 0;
  }
  if (parsed.opts.json) {
    console.log(JSON.stringify({ urn: result.urn, url: result.url, uploads: result.uploads }, null, 2));
  } else {
    console.log('Posted to LinkedIn ✔');
    if (result.urn) console.log(`URN: ${result.urn}`);
    if (result.url) console.log(`URL: ${result.url}`);
  }
  return 0;
}

function parseFlagMap(argv, spec, commandName) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      out.help = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(spec, arg)) {
      const key = spec[arg];
      if (key.endsWith('!')) {
        out[key.slice(0, -1)] = true;
      } else {
        out[key] = takeValue(argv, i, arg);
        i++;
      }
    } else if (arg.startsWith('-')) {
      throw new UsageError(`Unknown option for ${commandName}: ${arg}`);
    } else {
      out._.push(arg);
    }
  }
  return out;
}

async function cmdAuth(argv) {
  const sub = argv[0];
  if (!sub || sub === '-h' || sub === '--help') {
    console.log(AUTH_HELP);
    return sub ? 0 : 2;
  }
  const rest = argv.slice(1);
  switch (sub) {
    case 'login': {
      const flags = parseFlagMap(
        rest,
        {
          '--client-id': 'clientId',
          '--client-secret': 'clientSecret',
          '--port': 'port',
          '--scopes': 'scopes',
          '--timeout': 'timeout',
          '--no-browser': 'noBrowser!',
          '--json': 'json!',
        },
        'auth login'
      );
      if (flags.help) {
        console.log(AUTH_HELP);
        return 0;
      }
      const creds = await login({
        clientId: flags.clientId,
        clientSecret: flags.clientSecret,
        port: flags.port ? Number(flags.port) : undefined,
        scopes: flags.scopes,
        timeout: flags.timeout ? Number(flags.timeout) : undefined,
        noBrowser: flags.noBrowser,
      });
      if (flags.json) {
        console.log(JSON.stringify({ authenticated: true, person_urn: creds.person_urn, name: creds.name, expires_at: creds.expires_at }, null, 2));
      } else {
        console.log(`Authenticated as ${creds.name || 'LinkedIn member'} (${creds.person_urn}).`);
        if (creds.expires_at) console.log(`Token expires: ${creds.expires_at}`);
      }
      return 0;
    }
    case 'token': {
      const flags = parseFlagMap(rest, { '--person-urn': 'personUrn', '--json': 'json!' }, 'auth token');
      if (flags.help) {
        console.log(AUTH_HELP);
        return 0;
      }
      const creds = await setToken(flags._[0], { personUrn: flags.personUrn });
      if (flags.json) {
        console.log(JSON.stringify({ authenticated: true, person_urn: creds.person_urn, name: creds.name }, null, 2));
      } else {
        console.log(`Token stored. Acting as ${creds.name || 'LinkedIn member'} (${creds.person_urn}).`);
      }
      return 0;
    }
    case 'status': {
      const flags = parseFlagMap(rest, { '--json': 'json!' }, 'auth status');
      if (flags.help) {
        console.log(AUTH_HELP);
        return 0;
      }
      const st = status();
      if (flags.json) {
        console.log(JSON.stringify(st, null, 2));
      } else if (st.authenticated) {
        console.log(`Authenticated (${st.source === 'env' ? 'via LINKEDIN_ACCESS_TOKEN' : st.credentials_file}).`);
        if (st.name) console.log(`Member: ${st.name}`);
        if (st.person_urn) console.log(`URN: ${st.person_urn}`);
        if (st.expires_at) console.log(`Token expires: ${st.expires_at}`);
      } else {
        console.log(`Not authenticated: ${st.reason}`);
      }
      return st.authenticated ? 0 : 3;
    }
    case 'logout':
      if (rest.includes('-h') || rest.includes('--help')) {
        console.log(AUTH_HELP);
        return 0;
      }
      logout();
      console.log('Logged out; stored credentials deleted.');
      return 0;
    default:
      throw new UsageError(`Unknown auth subcommand "${sub}". Use login, token, status, or logout.`);
  }
}

async function cmdWhoami(argv) {
  const flags = parseFlagMap(argv, { '--json': 'json!' }, 'whoami');
  if (flags.help) {
    console.log('linkedin whoami — verify the current token against the LinkedIn API.\nOptions: --json');
    return 0;
  }
  const resolved = resolveToken();
  if (!resolved) {
    throw new AuthError('Not authenticated. Run `linkedin auth login` or set LINKEDIN_ACCESS_TOKEN.');
  }
  const who = await resolvePersonUrn(resolved.token);
  if (flags.json) {
    console.log(JSON.stringify({ person_urn: who.urn, name: who.name, token_source: resolved.source }, null, 2));
  } else {
    console.log(`${who.name || 'LinkedIn member'} (${who.urn}) — token from ${resolved.source === 'env' ? 'LINKEDIN_ACCESS_TOKEN' : 'stored credentials'}.`);
  }
  return 0;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        console.log(ROOT_HELP);
        return command ? 0 : 2;
      case '-V':
      case '--version':
      case 'version':
        console.log(version());
        return 0;
      case 'auth':
        return await cmdAuth(rest);
      case 'post':
        return await cmdPost(rest);
      case 'whoami':
        return await cmdWhoami(rest);
      default:
        throw new UsageError(`Unknown command "${command}". Run \`linkedin --help\` for usage.`);
    }
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${err.message}`);
      if (err instanceof UsageError) console.error('Run `linkedin --help` for usage.');
      return err.exitCode;
    }
    throw err;
  }
}
