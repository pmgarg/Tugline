/**
 * Deterministic red-team prefilter for the classifier approver (SPEC C3).
 *
 * The classifier is a (small) model: it can be wrong and it can be prompt-
 * injected through the very tool arguments it judges. So before any model sees
 * a call, this code escalates every call that touches one of the rubric's block
 * categories to a human. The prefilter only ever *escalates* (never allows), so
 * false positives cost an extra prompt and false negatives are still judged by
 * the classifier. It is a seatbelt, not a sandbox (obfuscation can defeat
 * pattern checks), which is why obfuscation itself is escalated.
 *
 * Third-party note: the IaC teardown pattern marked "ported from Qwen" below (pulumi/cdk destroy) is derived from
 * Qwen Code packages/core/src/permissions/destructive-commands.ts, commit c726d2c, Copyright 2025 Qwen Team,
 * SPDX-License-Identifier: Apache-2.0. Modified by Tugline contributors, 2026-10-31: rewritten as one regex with
 * `serverless remove` and `docker compose down -v` added. Listed in docs/THIRD_PARTY.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CheckInput } from '../permissions/policy.js';
import { splitCommandSegments } from '../permissions/policy.js';
import { normalizeCommand } from './normalize.js';
import { FILE_READERS, PATTERN_FIRST } from './readers.js';

export const BLOCK_CATEGORIES = ['destructive', 'credential-access', 'exfiltration', 'outside-workspace-write', 'publishing', 'persistence', 'security-weakening'] as const;
export type BlockCategory = (typeof BLOCK_CATEGORIES)[number];

export interface PrefilterHit {
  category: BlockCategory;
  reason: string;
}

export interface PrefilterQuery {
  tool: string;
  input: CheckInput;
  args: unknown;
  /** The policy's reason for asking. */
  reason: string;
}

type Rule = [BlockCategory, RegExp, string];

/** Patterns over the whole command line (quotes kept, so `"$(…)"` is still visible). */
const COMMAND_RULES: Rule[] = [
  // ---- destructive / irreversible
  ['destructive', /\brm\s+(?:-[a-zA-Z-]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-\S+\s+)*["']?(?:\/|~|\$|\.\.?(?:\/|\s|$|["'])|\*)/, 'recursive delete of an absolute, home, parent, variable or wildcard path'],
  // build-cache cleanup inside the workspace (find . -name "*.pyc" -delete) is routine; any other find -delete is not
  ['destructive', /\bfind\b(?!\s+(?:\.|\.\/[\w./-]*|[A-Za-z_][\w./-]*)\s+(?:-type\s+[fd]\s+)?-name\s+["']?(?:\*\.(?:pyc|pyo|o|class)|__pycache__|\.DS_Store|\.pytest_cache)["']?\s+(?:-type\s+[fd]\s+)?-delete\s*(?:$|[;&|]))[^|;&]*\s-(?:delete|exec\s+rm)\b/, 'find -delete / -exec rm'],
  ['destructive', /\bgcloud\s+(?:\S+\s+){1,5}(?:delete|remove|destroy)\b|\baz\s+(?:\S+\s+){1,5}(?:delete|purge|remove)\b/, 'deletes cloud resources'],
  ['destructive', /\brsync\b[^;&|]*\s--(?:del|delete(?:-\w+)?|remove-source-files)\b/, 'rsync that deletes files (--delete / --remove-source-files)'],
  ['credential-access', /\bop\s+(?:item\s+get|read|inject|document\s+get)\b|\bvault\s+(?:kv\s+get|read)\b|\bsecurity\s+find-(?:generic|internet)-password\b|\bpass\s+show\b|\bgcloud\s+secrets\s+versions\s+access\b|\baws\s+secretsmanager\s+get-secret-value\b|\bbw\s+get\b|\bgh\s+auth\s+token\b|\bkubectl\s+get\s+secrets?\b|\bsecret-tool\s+lookup\b/, 'reads a secret from a password manager or secret store'],
  ['credential-access', /\blpass\s+(?:show|export)\b|\bgopass\s+(?:show|cat)\b|\bkeepassxc-cli\s+(?:show|export)\b|\bbw\s+export\b|\baz\s+keyvault\s+(?:secret|key|certificate)\s+(?:show|download|list-versions)\b|\bheroku\s+config\b|\bdoppler\s+secrets\b|\binfisical\s+(?:secrets|export)\b|\bsops\s+(?:[^;&|]*\s)?(?:-d|--decrypt|exec-env|exec-file)\b|\baws\s+ssm\s+get-parameters?(?:-by-path)?\b|\bchamber\s+(?:read|export|exec)\b|\baz\s+account\s+get-access-token\b|\baz\s+ad\s+sp\s+credential\b|\bgcloud\s+auth\s+application-default\s+print-access-token\b|\baws\s+sts\s+(?:assume-role|get-session-token|get-federation-token)\b|\bkubectl\s+create\s+token\b/, 'reads a secret from a password manager or secret store'],
  // git config keys are case-insensitive: `http.SSLVerify=False` is the same setting
  ['security-weakening', /\bhttp\.(?:[^\s.=]+\.)?sslverify\s*[=\s]\s*["']?(?:false|0|no|off)\b|\bhttp\.(?:[^\s.=]+\.)?sslcainfo\s*[=\s]\s*["']?\/dev\/null/i, 'disables TLS verification'],
  ['exfiltration', /\b(?:curl|xh)\b[^;&|]*\s-[a-zA-Z]*[dFT][a-zA-Z]*(?:\s|=|@)/, 'sends data to a remote server (combined short flags)'],
  ['destructive', /\bgit\s+(?:-\S+\s+)*(?:reset\s+[^;&|]*--hard|clean\s+[^;&|]*-[a-zA-Z]*f|checkout\s+(?:--\s+)?\.(?:\s|$)|restore\s+(?:--\S+\s+)*\.(?:\s|$)|branch\s+[^;&|]*-D\b|stash\s+(?:drop|clear)|filter-branch|filter-repo|reflog\s+expire|update-ref\s+-d|gc\s+[^;&|]*--prune)/, 'discards git history or uncommitted work'],
  ['destructive', /\b(?:dd\s+[^;&|]*of=|mkfs\b|shred\b|wipefs\b|fdisk\b|truncate\s+-s\s*0)/, 'overwrites disks or files irreversibly'],
  ['destructive', /\b(?:dropdb|flushall|flushdb|dropDatabase|dropUser|dropAllUsers|dropIndexes)\b|\bdb\.\w+\.(?:drop|deleteMany|remove)\s*\(|\bDROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|KEYSPACE|COLLECTION|USER|ROLE|VIEW)\b|\bTRUNCATE\s+(?:TABLE\s+)?[\w"`.]+|\bDELETE\s+FROM\s+[\w"`.]+\s*(?:;|"|'|$)|\bredis-cli\b[^;&|]*\b(?:FLUSHALL|FLUSHDB|DEL|UNLINK|CONFIG\s+SET)\b/i, 'destructive data-store command'],
  // N43 (ported from Qwen destructive-commands.ts IaC patterns): pulumi/cdk/serverless teardown, compose volume removal
  ['destructive', /\bpulumi\s+(?:\S+\s+)*destroy\b|\bcdk\s+(?:\S+\s+)*destroy\b|\b(?:serverless|sls)\s+remove\b|\bdocker[\s-]compose\s+(?:\S+\s+)*down\b[^;&|]*\s(?:-v|--volumes)\b/, 'tears down infrastructure or deletes its data'],
  ['destructive', /\bdocker\s+(?:system\s+prune|volume\s+(?:rm|prune)|rm\s+-f|rmi\b)|\bkubectl\s+delete\b|\bterraform\s+destroy\b|\bhelm\s+(?:uninstall|delete)\b|\b(?:aws\s+s3\s+(?:rm|rb)|gsutil\s+(?:-m\s+)?rm|az\s+\w+\s+delete)\b/, 'deletes infrastructure or data stores'],
  ['destructive', /\bchmod\s+(?:-\S+\s+)*0{3,4}\b|\bchown\s+(?:-\S+\s+)*(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\s/, 'recursive ownership/permission change'],
  ['destructive', /\bmv\s+[^;&|]*\s\/dev\/null\b|:\s*>\s*[^\s&|;]+|\bkill\s+-9\s+-1\b|\bpkill\b|\bkillall\b/, 'destroys files or processes'],
  // ---- credential access
  ['credential-access', /(?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s]+|\/Users\/[^/\s]+|\/root)\/\.(?:ssh|aws|gnupg|kube|docker|config\/gcloud|azure|netrc|npmrc|pypirc|git-credentials)\b/, 'reads credential stores in the home directory'],
  ['credential-access', /(?:^|[\s"'=/])(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)\b|\.pem\b|\.p12\b|\.pfx\b|\.keystore\b|\bcredentials(?:\.json)?\b|(?:^|[\s"'/])\.env(?:\.\w+)?(?:[\s"']|$)|\.git-credentials\b|\.netrc\b|\.npmrc\b|\.pypirc\b/, 'touches a secrets file'],
  ['credential-access', /\/etc\/(?:shadow|gshadow|sudoers|master\.passwd)\b|\/proc\/(?:self|\d+)\/environ\b/, 'reads system credential files or process environments'],
  ['credential-access', /\bsecurity\s+(?:find-(?:generic|internet)-password|dump-keychain|export)\b|\bsecret-tool\s+lookup\b|\bkeyctl\b|\bgpg\s+[^;&|]*--export-secret|\bgh\s+auth\s+token\b|\bgcloud\s+auth\s+(?:print-access-token|print-identity-token)\b|\baws\s+(?:configure\s+get|sts\s+get-session-token|secretsmanager\s+get-secret-value|ssm\s+get-parameter)\b|\bvault\s+(?:read|kv\s+get)\b|\bkubectl\s+get\s+secrets?\b/, 'extracts credentials or tokens'],
  ['credential-access', /(?:^|[;&|]\s*)(?:printenv|env|set|export\s+-p|declare\s+-x)\s*(?:$|[;&|>])|\becho\s+[^;&|]*\$\{?[A-Z_]*(?:KEY|TOKEN|SECRET|PASS|PASSWORD|CREDENTIAL)[A-Z_]*\}?|\b(?:printenv|getenv)\s+(?:-\S+\s+)*[A-Za-z_]*(?:KEY|TOKEN|SECRET|PASS|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION)[A-Za-z0-9_]*\b/, 'dumps environment variables or secrets'],
  ['credential-access', /169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200|fd00:ec2::254/, 'cloud metadata endpoint (instance credentials)'],
  // ---- exfiltration (network + data)
  // Case-sensitive on purpose: curl's -f (fail) is not -F (form); program names are lower-cased by the normaliser.
  ['exfiltration', /\b(?:curl|http|https|xh)\b[^;&|]*\s(?:-d|--data(?:-\w+)?|-F|--form(?:-string)?|-T|--upload-file|--json|-X\s*(?:POST|PUT|PATCH|post|put|patch)|--request\s+(?:POST|PUT|PATCH|post|put|patch))(?:\s|=|$|@)/, 'sends data to a remote server'],
  ['exfiltration', /\bwget\b[^;&|]*--(?:post-data|post-file|body-data|body-file|method=(?:POST|PUT))/i, 'sends data to a remote server'],
  ['exfiltration', /(?:^|[\s|;&(])(?:nc|ncat|netcat|socat|telnet)\s|\/dev\/tcp\/|\/dev\/udp\//, 'raw network connection'],
  ['exfiltration', /\b(?:scp|sftp|ftp|rsync)\b[^;&|]*\s[\w.-]+@?[\w.-]*:[^\s]*|\brclone\s+(?:copy|sync|move)\b|\bssh\s+[^;&|]*-[RLD]\s/, 'copies files to or tunnels via a remote host'],
  ['exfiltration', /\baws\s+s3\s+(?:cp|mv|sync)\b[^;&|]*\ss3:\/\/\S*\s*(?:$|[;&|]|\s-)|\baws\s+s3api\s+put-object\b|\bgsutil\s+(?:-\S+\s+)*(?:cp|mv|rsync)\b[^;&|]*\sgs:\/\/\S*\s*(?:$|[;&|]|\s-)|\bgcloud\s+storage\s+(?:cp|mv|rsync)\b[^;&|]*\sgs:\/\/\S*\s*(?:$|[;&|]|\s-)|\baz\s+storage\s+(?:blob|file|fs\s+file|azcopy)\s+(?:upload|upload-batch|copy|sync)\b|\bazcopy\s+(?:copy|cp|sync)\b|\bs3cmd\s+(?:put|sync|cp)\b|\bb2\s+(?:upload-file|upload_file|sync)\b|\bmc\s+(?:cp|mirror)\b[^;&|]*\s\w+\/\S*\s*$|\boci\s+os\s+object\s+put\b/, 'uploads files to cloud storage'],
  ['credential-access', /\b(?:grep|egrep|fgrep|rg|ag|ack|git\s+grep|findstr|Select-String)\b[^;&|]*(?:AKIA|ASIA|AIza|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abposr]-|sk-[A-Za-z0-9]|sk_live|rk_live|BEGIN[\s\w]*PRIVATE KEY|PRIVATE KEY|aws_secret_access_key|aws_access_key_id|aws_session_token|-----BEGIN)/i, 'searches for credentials'],
  ['credential-access', /(?:\bos\.environ\b(?!\s*(?:\.get\s*\(|\[)\s*["'](?:PATH|HOME|PWD|LANG|TERM|CI)["'])|\bprocess\.env\b(?!\s*\.\s*(?:NODE_ENV|PATH|HOME|PWD|CI|TERM|LANG)\b)|%ENV\b|\bENV\s*\.\s*(?:to_h|each|inspect|keys|map)|\bgetenv\s*\(\s*\)|Deno\.env\.toObject|\$_ENV\b|\$_SERVER\b)/, 'reads the whole process environment (credentials live there)'],
  ['destructive', /(?:^|[\s;&|(])(?:python\d*(?:\.\d+)?|pypy\d*|node|nodejs|deno|bun|perl|ruby|php|lua|Rscript|osascript|pwsh|powershell)\s+(?:-\S+\s+)*?(?:-c|-e|-E|-r|--eval|-p|--print|-[a-zA-Z]*e|-Command)\b[\s\S]*\b(?:rmtree|rmSync|rmdirSync|rmdir|unlink(?:Sync)?|unlinkat|os\.remove|os\.removedirs|shutil\.move|Path\([^)]*\)\.unlink|\.unlink\s*\(|fs\.rm\b|fsPromises\.rm|rm_rf|rm_r\b|FileUtils\.(?:rm|remove)|File\.delete|Dir\.delete|Remove-Item|truncate\s*\(|ftruncate|os\.rename|renameSync|writeFileSync\s*\(\s*(?:process\.env|["'`]?(?:\/|~))|chmodSync|chownSync|os\.chmod|os\.chown)\b/, 'inline interpreter code deletes, moves or changes permissions of files'],
  ['security-weakening', /(?:^|[\s;&|(])(?:python\d*(?:\.\d+)?|pypy\d*|node|nodejs|deno|bun|perl|ruby|php|lua|Rscript|osascript|pwsh|powershell)\s+(?:-\S+\s+)*?(?:-c|-e|-E|-r|--eval|-p|--print|-[a-zA-Z]*e|-Command)\b[\s\S]*(?:\bos\.system\b|\bos\.popen\b|\bos\.exec\w*|\bos\.spawn\w*|\bos\.kill\b|\bpty\.spawn|\bsubprocess\b|\bchild_process\b|\bexecSync\b|\bexecFile\w*|\bspawnSync\b|\bspawn\s*\(|\bfork\s*\(|(?<![\w.])system\s*\(|(?<![\w.])exec\s*[(\s"']|\bpopen\b|\bshell_exec\b|\bpassthru\b|\bproc_open\b|\bKernel\.(?:system|exec|spawn)|\bOpen3\b|\bIO\.popen|\bDeno\.(?:run|Command)|\bBun\.(?:spawn|\$)|Start-Process|Invoke-Expression|\biex\b|do shell script|`)/, 'inline interpreter code runs other programs'],
  ['exfiltration', /(?:^|[\s;&|(])(?:python\d*(?:\.\d+)?|pypy\d*|node|nodejs|deno|bun|perl|ruby|php|lua|Rscript|osascript|pwsh|powershell)\s+(?:-\S+\s+)*?(?:-c|-e|-E|-r|--eval|-p|--print|-[a-zA-Z]*e|-Command)\b[\s\S]*(?:\burlopen\b|\burllib\b|\brequests\s*\.|\bhttpx\b|\baiohttp\b|\bhttp\.client\b|\bhttplib\b|\bsocket\b|\bsmtplib\b|\bftplib\b|\bparamiko\b|\bfetch\s*\(|\baxios\b|\bgot\s*\(|XMLHttpRequest|\bhttps?\s*\.\s*(?:get|request)\b|require\s*\(\s*["'](?:node:)?(?:https?|net|tls|dgram|dns)["']\s*\)|\bnet\s*\.\s*(?:connect|createConnection)|\bdns\s*\.\s*(?:resolve|lookup)|WebSocket|Net::HTTP|\bLWP\b|IO::Socket|HTTP::Tiny|\bcurl_(?:init|exec)\b|fsockopen|file_get_contents\s*\(\s*["']https?:|\bopen-uri\b|URI\.open|Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b|Net\.WebClient|Deno\.connect)/, 'inline interpreter code opens network connections'],
  ['exfiltration', /\|\s*(?:curl|wget|nc|ncat|netcat|ssh|scp|mail|sendmail|mutt)\b|\b(?:mail|sendmail|mutt)\s+-s\b/, 'pipes data to the network or e-mail'],
  ['exfiltration', /\b(?:curl|wget|dig|nslookup|host|ping)\b[^;&|]*(?:\$\(|`|\$\{?[A-Za-z_])/, 'network request built from command output or variables'],
  ['exfiltration', /\bngrok\b|\bcloudflared\s+tunnel\b|\blocaltunnel\b|\blt\s+--port\b|\bpython\d?\s+-m\s+(?:http\.server|SimpleHTTPServer)\b[^;&|]*--bind\s+0\.0\.0\.0|\bnpx\s+(?:serve|http-server)\b[^;&|]*-l\s+tcp:\/\/0\.0\.0\.0/, 'exposes the machine to the internet'],
  // ---- v1.2 live run (OpenRouter qwen3.8-27b / qwen3.5-9b, 5 Nov): categories the classifier let through; deterministic now
  ['credential-access', /\bkubectl\s+(?:\S+\s+)*config\s+view\b[^;&|]*(?:--raw|--flatten)\b|\bkubectl\s+(?:\S+\s+)*get\s+secrets?\b[^;&|]*(?:-o\s*(?:yaml|json|jsonpath)|--output)|\bkubectl\s+(?:\S+\s+)*create\s+token\b|\baws\s+(?:\S+\s+)*(?:configure\s+(?:get|export-credentials)|sts\s+get-session-token|ecr\s+get-login-password|codeartifact\s+get-authorization-token)\b|\bgcloud\s+(?:\S+\s+)*(?:auth\s+(?:print-access-token|print-identity-token|application-default\s+print-access-token)|config\s+config-helper)\b|\baz\s+account\s+get-access-token\b|\b(?:glab|hub)\s+auth\s+(?:token|status\s+[^;&|]*-t)\b|\bdocker\s+(?:\S+\s+)*login\b[^;&|]*--password|\bnpm\s+token\s+(?:list|create)\b|\bvault\s+(?:print\s+token|token\s+lookup)\b/, 'prints credentials or access tokens'],
  ['security-weakening', /(?:^|[\s;&|(])(?:GIT_EXTERNAL_DIFF|GIT_PAGER|PAGER|GIT_EDITOR|EDITOR|VISUAL|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_PROXY_COMMAND|LESSOPEN|LESSCLOSE|GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)|BASH_ENV|ENV|PROMPT_COMMAND|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_\w+|NODE_OPTIONS|PYTHONSTARTUP|PERL5OPT|RUBYOPT)=/, 'sets an environment variable that makes the command run another program'],
  ['security-weakening', /\bgit\s+(?:-\S+\s+)*grep\b[^;&|]*(?:\s--op[\w-]*|\s-[a-zA-Z]*O)|\bgit\s+(?:-\S+\s+)*(?:diff|log|show)\b[^;&|]*\s--ext[\w-]*|\bgit\s+(?:-\S+\s+)*-c\s*["']?[\w.-]*(?:pager|editor|sshcommand|fsmonitor|hookspath|askpass|textconv|\.command|external)\b/i, 'git option that runs another program (pager, external diff, config override)'],
  ['destructive', /\balembic\s+(?:\S+\s+)*downgrade\b|\b(?:rails|rake|bin\/rails)\s+db:(?:drop|reset|rollback|schema:load|purge|migrate:reset)\b|\bprisma\s+(?:migrate\s+reset|db\s+push\s+[^;&|]*--force-reset)\b|\bmanage\.py\s+(?:flush|sqlflush|migrate\s+\S+\s+zero)\b|\bknex\s+migrate:(?:rollback|down)\b|\bsequelize(?:-cli)?\s+db:(?:drop|migrate:undo)\b|\b(?:flyway|liquibase)\s+(?:\S+\s+)*(?:clean|rollback|drop-all)\b|\bphp\s+artisan\s+(?:migrate:(?:fresh|reset|rollback|refresh)|db:wipe)\b|\bdbmate\s+(?:drop|down|rollback)\b|\bmongosh?\b[^;&|]*--eval\s+[^;&|]*drop/, 'rolls back or wipes a database schema or its data'],
  // ---- publishing
  ['publishing', /\bgit\s+(?:-\S+\s+)*(?:push|remote\s+(?:add|set-url)|send-email|request-pull)\b/, 'pushes or retargets a git remote'],
  ['publishing', /\b(?:npm|pnpm|yarn|bun)\s+(?:\S+\s+)?publish\b|\b(?:twine\s+upload|cargo\s+publish|gem\s+push|poetry\s+publish|flit\s+publish|hatch\s+publish|dotnet\s+nuget\s+push|mvn\s+[^;&|]*deploy|gradle\w*\s+[^;&|]*publish|helm\s+push|docker\s+push|podman\s+push|semantic-release|release-it|changeset\s+publish|lerna\s+publish|goreleaser(?:\s+release)?|np\s+(?:patch|minor|major|\d))\b/, 'publishes a package or image'],
  ['publishing', /\bgh\s+(?:release\s+(?:create|upload|delete|edit)|pr\s+(?:create|merge|close|comment|review)|repo\s+(?:create|delete|edit|rename|archive)|issue\s+(?:create|comment|close|delete)|gist\s+create|api\s+[^;&|]*-X\s*(?:POST|PUT|PATCH|DELETE)|secret\s+set|workflow\s+run)\b|\bglab\s+(?:mr|release|repo)\s+(?:create|merge|delete)\b/, 'changes something on GitHub/GitLab'],
  ['publishing', /\b(?:kubectl\s+(?:apply|create|replace|patch|scale|rollout)|terraform\s+apply|pulumi\s+up|vercel\s+[^;&|]*--prod|netlify\s+deploy|fly(?:ctl)?\s+deploy|firebase\s+deploy|heroku\s+[^;&|]*(?:deploy|releases)|serverless\s+deploy|sls\s+deploy|aws\s+\S+\s+(?:deploy|update-function-code|put-object)|gcloud\s+[^;&|]*\s(?:deploy|update))\b/, 'deploys to shared infrastructure'],
  // ---- persistence
  ['persistence', /\bcrontab\b|\/etc\/cron|\bat\s+(?:now|\d)|\bsystemctl\s+(?:--user\s+)?(?:enable|start|daemon-reload)\b|\blaunchctl\s+(?:load|bootstrap|enable|submit)\b|LaunchAgents|LaunchDaemons|\bupdate-rc\.d\b|\bchkconfig\b|\.config\/autostart|\/etc\/(?:init\.d|rc\.local|profile\.d|systemd)/, 'schedules or installs something that runs later'],
  ['persistence', /(?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s]+|\/Users\/[^/\s]+|\/root)\/\.(?:bashrc|bash_profile|bash_login|profile|zshrc|zshenv|zprofile|zlogin|config\/fish|inputrc|ssh\/authorized_keys|ssh\/config|gitconfig)\b|authorized_keys/, 'modifies shell startup files or SSH access'],
  ['persistence', /\.git\/hooks\b|\bgit\s+config\s+[^;&|]*(?:core\.hooksPath|core\.fsmonitor|core\.sshCommand|core\.pager|alias\.|include\.path|credential\.helper|filter\.\S+\.(?:clean|smudge)|diff\.\S+\.textconv|--global|--system)|\.husky\/|\bnpm\s+(?:config\s+set|set-script)\b|\b(?:yarn|pnpm)\s+config\s+set\b|\bpip\s+config\s+set\b/, 'installs hooks or changes tool configuration that runs code later'],
  // ---- security weakening (incl. obfuscation and privilege escalation)
  ['security-weakening', /(?:^|[\s;&|(])(?:sudo|doas|su|pkexec)\s/, 'privilege escalation'],
  ['security-weakening', /\bchmod\s+(?:-\S+\s+)*(?:0?777|a\+w|o\+w|[ugoa]*\+s|[2467]\d{3})\b|\bsetenforce\s+0\b|\bufw\s+disable\b|\biptables\s+-F\b|\bspctl\s+--master-disable\b|\bcsrutil\s+disable\b|\bxattr\s+-[a-z]*d\s+com\.apple\.quarantine/, 'weakens system security'],
  ['security-weakening', /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|PYTHONHTTPSVERIFY\s*=\s*["']?0|GIT_SSL_NO_VERIFY|http\.sslVerify\s*[=\s]\s*["']?(?:false|0|no|off)\b|strict-?ssl\s*[=\s]\s*["']?(?:false|0)\b|\bstrictSSL\s*[=\s]\s*["']?(?:false|0)\b|ssl[-_]verify\s*[=\s]\s*["']?(?:false|0|no)\b|--trusted-host\b|(?:^|\s)--insecure(?:\s|=|$)|\b(?:curl|xh|https?|grpcurl|helm)\b[^;&|]*\s-k(?:\s|$)|\bcurl\b[^;&|]*\s-[a-zA-Z]*k[a-zA-Z]*(?:\s|$)|--no-check-certificate\b|\bverify\s*=\s*False\b|(?:CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS)\s*=\s*(?:["']{2}|\/dev\/null|\s|$)|rejectUnauthorized\s*:\s*false|InsecureSkipVerify|check_hostname\s*=\s*False|CERT_NONE/, 'disables TLS verification'],
  ['security-weakening', /StrictHostKeyChecking\s*[=\s]\s*["']?(?:no|off|false|0)\b|UserKnownHostsFile\s*[=\s]\s*["']?(?:\/dev\/null|NUL)\b|GlobalKnownHostsFile\s*[=\s]\s*["']?\/dev\/null|CheckHostIP\s*[=\s]\s*["']?no\b|\bssh-keyscan\b[^;&|]*>>?\s*\S*known_hosts/i, 'disables SSH host-key verification'],
  ['security-weakening', /--no-verify\b|--dangerously|--no-sandbox\b|--disable-web-security\b/, 'skips verification hooks or safety checks'],
  ['security-weakening', /\b(?:base64|openssl\s+(?:enc|base64))\s+[^;&|]*-(?:d|D|-decode)\b|\bxxd\s+-r\b|\\x[0-9a-fA-F]{2}|\$'\\|(?<![-\w])eval\b|\bsource\s+<\(|(?:^|[^<])<\(\s*(?:curl|wget)|\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\|\s*(?:python\d*|node|perl|ruby|php)\b(?!\s+-m\s+json)|\bexec\s*\(|\b__import__\s*\(|\bcompile\s*\(/, 'obfuscated or dynamically generated code'],
];

/** Paths that indicate persistence when written (workspace-relative or absolute). */
const PERSIST_PATH = /(?:^|\/)(?:\.bashrc|\.bash_profile|\.bash_login|\.profile|\.zshrc|\.zshenv|\.zprofile|\.zlogin|authorized_keys|crontab|\.gitconfig)$|(?:^|\/)\.git\/hooks\/|(?:^|\/)\.husky\/|LaunchAgents\/|LaunchDaemons\/|\/etc\/|\.config\/autostart\/|\.config\/fish\/|\.config\/systemd\//;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\.[\w-]+)?|id_rsa[^/]*|id_ed25519[^/]*|id_ecdsa[^/]*|[^/]*\.pem|[^/]*\.key|[^/]*\.p12|[^/]*\.pfx|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials[^/]*)$|(?:^|\/)\.(?:ssh|aws|gnupg|kube|docker)\//i;

/**
 * The physical spelling of a path: symlinks resolved for the longest prefix that exists, the
 * rest appended. On macOS `/tmp`, `/var` and `/etc` are symlinks into `/private`, and
 * `os.tmpdir()` is under `/var/folders/…`, so a workspace, a target and a safe root may each be
 * spelled either way. Every containment check compares physical spellings, so the answer is the
 * same on Linux and macOS, and a symlink inside the workspace that points out of it counts as out.
 */
export function physicalPath(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  for (let head = abs; ; ) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/** `p` is `root` or below it (both already physical). */
function within(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Character devices that are safe to write by name (their physical paths vary per process). */
const SAFE_WRITE_DEVICES = ['/dev/null', '/dev/stdout', '/dev/stderr'];
/** Scratch directories; `os.tmpdir()` is `/tmp` on Linux and `/var/folders/…/T` on macOS. */
const scratchRoots = (): string[] => [...new Set(['/tmp', '/private/tmp', '/var/tmp', os.tmpdir()].map(physicalPath))];

function outsideWrite(target: string, workspace: string): boolean {
  const t = target.replace(/^["']|["']$/g, '');
  if (!t || t.startsWith('-') || t.startsWith('&')) return false;
  if (SAFE_WRITE_DEVICES.includes(t)) return false;
  if (/^(?:~|\$HOME|\$\{HOME\})/.test(t)) return true;
  const phys = physicalPath(path.resolve(workspace, t));
  if (within(phys, physicalPath(workspace))) return false;
  // Scratch dirs are safe when named as such (`/tmp/x`), not when reached by climbing out of the
  // workspace (`../x`), which may itself sit in a scratch dir.
  return !(path.isAbsolute(t) && scratchRoots().some((r) => within(phys, r)));
}

/** Write targets in a shell command: redirections, tee, and destinations of cp/mv/ln/install/curl -o. */
export function commandWriteTargets(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/(?:^|[^0-9&<>])>{1,2}\|?\s*([^\s;&|<>]+)/g)) out.push(m[1]);
  for (const seg of splitCommandSegments(command)) {
    const t = seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]!)) t.shift();
    const prog = path.basename(t[0] ?? '');
    const args = t.slice(1).filter((x) => !x.startsWith('-'));
    if (prog === 'tee') out.push(...args);
    if (['cp', 'mv', 'ln', 'install', 'rsync'].includes(prog) && args.length >= 2) out.push(args[args.length - 1]);
    if (['curl', 'wget'].includes(prog)) {
      const i = t.findIndex((x) => x === '-o' || x === '--output' || x === '-O' || x === '--output-document');
      if (i >= 0 && t[i + 1]) out.push(t[i + 1]);
    }
    if (prog === 'mkdir' || prog === 'touch') out.push(...args);
  }
  return out;
}

/** Tokens of one simple command (quotes removed), skipping env assignments and transparent wrappers. */
function argv(seg: string): string[] {
  const t = [...seg.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
  for (;;) {
    if (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]!)) t.shift();
    else if (t.length && ['command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'env', 'stdbuf', 'unbuffer'].includes(path.basename(t[0]!))) t.shift();
    else if (t.length && path.basename(t[0]!) === 'timeout') t.splice(0, t[1] && /^\d/.test(t[1]) ? 2 : 1);
    else if (t.length && path.basename(t[0]!) === 'xargs') {
      t.shift();
      while (t.length && t[0]!.startsWith('-')) t.splice(0, ['-I', '-n', '-P', '-L', '-d', '-s', '-E'].includes(t[0]!) ? 2 : 1);
    } else break;
  }
  return t;
}

/** Build/cache directories a recursive delete may target without a human (recoverable, regenerated). */
const RM_SAFE_TARGET = /^(?:\.\/)?(?:dist|build|out|target|coverage|node_modules|\.cache|tmp|\.tmp|temp|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.next|\.nuxt|\.svelte-kit|\.turbo|\.parcel-cache|\.angular|\.gradle|bin|obj|\.venv|venv|\.tox|\.nox|htmlcov|\.nyc_output|[\w.-]+\.egg-info|\.eggs|storybook-static|\.docusaurus)(?:\/[\w.@+-]+)*\/?$/;

/** A recursive rm (flags combined or split, also via xargs) of anything but build/cache dirs. */
export function unsafeRecursiveRm(command: string): string | null {
  for (const seg of splitCommandSegments(command)) {
    const t = argv(seg);
    if (path.basename(t[0] ?? '') !== 'rm') continue;
    let recursive = false;
    let endOpts = false;
    const targets: string[] = [];
    for (const a of t.slice(1)) {
      if (!endOpts && a === '--') endOpts = true;
      else if (!endOpts && a.startsWith('--')) recursive ||= a === '--recursive';
      else if (!endOpts && /^-[a-zA-Z]+$/.test(a)) recursive ||= /[rR]/.test(a);
      else targets.push(a);
    }
    if (!recursive) continue;
    if (!targets.length || seg !== seg.replace(/^\s*xargs\b/, '')) return 'recursive delete of paths read from input';
    const bad = targets.find((x) => x.includes('..') || !RM_SAFE_TARGET.test(x));
    if (bad) return `recursive delete of ${bad} (only build/cache directories are routine)`;
  }
  return null;
}

// N43 (review finding 1): every program the auto-mode fast path treats as a file reader is checked here too
const SEARCH_PROGS_BASE = ['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'fdfind', 'locate', 'mlocate', 'plocate', 'ls', 'tree', 'du', 'cat', 'head', 'tail', 'less', 'more', 'strings', 'xxd', 'od', 'hexdump', 'base64', 'tac', 'nl', 'zcat', 'bat', 'sqlite3', 'jq', 'yq'];
const SEARCH_PROGS = new Set([...SEARCH_PROGS_BASE, ...FILE_READERS]);
/** Readable system locations that hold no user secrets. */
const READ_OK_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/dev/null', '/proc/cpuinfo', '/proc/meminfo', '/proc/version', '/etc/os-release', '/etc/hostname'];

function outsideRead(arg: string, workspace: string): boolean {
  const a = arg.replace(/^["']|["']$/g, '');
  if (/^(?:~|\$HOME|\$\{HOME\})(?:\/|$)/.test(a)) return true;
  if (!path.isAbsolute(a) && !a.startsWith('..')) return false;
  const phys = physicalPath(path.resolve(workspace, a));
  if (within(phys, physicalPath(workspace))) return false;
  // As for writes: system and scratch roots are fine when named, not when reached via `../`.
  return !(path.isAbsolute(a) && [...READ_OK_ROOTS.map(physicalPath), ...scratchRoots()].some((r) => within(phys, r)));
}

/**
 * `ls` of exactly the workspace's own parent directory (`ls ..`, `ls -la ../`, `ls -d ..`, or its
 * absolute path) only shows the names of the workspace's siblings, so it is not credential access.
 * Anything more stays escalated: a recursive listing (`-R`), a sibling (`ls ../other`), a glob
 * (`ls ../*`), a grandparent (`ls ../..`), and every read, search or `tree`/`du` of the parent.
 */
function listsOwnParent(prog: string, args: string[], arg: string, workspace: string): boolean {
  if (prog !== 'ls' || args.some((x) => x === '--recursive' || /^-[a-zA-Z]*R/.test(x))) return false;
  const a = arg.replace(/^["']|["']$/g, '');
  if (/[*?[{]/.test(a)) return false;
  const ws = physicalPath(workspace);
  return physicalPath(path.resolve(ws, a)) === path.dirname(ws);
}

/** Searches and reads that reach outside the workspace (home directory, other projects, /etc …). */
export function outsideSearch(command: string, workspace: string): string | null {
  for (const seg of splitCommandSegments(command)) {
    const t = argv(seg);
    const prog = path.basename(t[0] ?? '');
    if (!SEARCH_PROGS.has(prog)) continue;
    if (prog === 'locate' || prog === 'mlocate' || prog === 'plocate') return 'searches the whole filesystem index';
    const rest = t.slice(1);
    if (prog === 'git') {
      // git reads arbitrary files only with --no-index (diff) or as paths after `--`
      const dd = rest.indexOf('--');
      const files = rest.includes('--no-index') ? rest.slice(1).filter((x) => !x.startsWith('-')) : dd >= 0 ? rest.slice(dd + 1) : [];
      for (const a of files) if (outsideRead(a, workspace)) return `reads outside the workspace: ${a}`;
      continue;
    }
    // grep-likes (and sed/awk/jq scripts): the first positional is the pattern unless -e/-f/--regexp gave it
    const grepLike = PATTERN_FIRST.has(prog);
    let patternTaken = !grepLike || rest.some((x) => /^(?:-e|-f|--regexp(?:=|$)|--file(?:=|$))/.test(x));
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a.startsWith('-')) {
        if (['-e', '-f', '--regexp', '--file', '-g', '--glob', '-t', '--type', '-name', '-iname', '-path', '-type', '-maxdepth', '-mindepth', '-newer'].includes(a)) i++;
        continue;
      }
      if (!patternTaken) {
        patternTaken = true;
        continue;
      }
      if (outsideRead(a, workspace) && !listsOwnParent(prog, rest, a, workspace)) return `reads or searches outside the workspace: ${a}`;
    }
  }
  return null;
}

/** The code strings of every `sh -c '…'` / `bash -c "…"` in a command (quotes handled). */
export function shellCStrings(command: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s;&|(`$])(?:\S*\/)?(?:ba|z|da|k|fi|c|tc)?sh\s+(?:-[a-zA-Z]+\s+)*?-[a-zA-Z]*c[a-zA-Z]*\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    let i = m.index + m[0].length;
    const q = command[i];
    let code = '';
    if (q === "'") {
      const end = command.indexOf("'", i + 1);
      code = command.slice(i + 1, end < 0 ? undefined : end);
    } else if (q === '"') {
      for (i++; i < command.length && command[i] !== '"'; i++) code += command[i] === '\\' && i + 1 < command.length ? command[++i] : command[i];
    } else code = command.slice(i).split(/[;&|]/)[0] ?? '';
    if (code.trim()) out.push(code);
  }
  return out;
}

function urlOf(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const u = a.url ?? a.uri ?? a.href;
  return typeof u === 'string' ? u : undefined;
}

/** `find . -name "__pycache__" -type d -prune -exec rm -rf {} +`: routine cache cleanup inside the workspace (exact form only). */
const CACHE_CLEAN = /^find\s+\.\s+(?:-type\s+d\s+)?-name\s+["']?(?:__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)["']?\s+(?:-type\s+d\s+)?(?:-prune\s+)?-exec\s+rm\s+-(?:rf|fr|r)\s+(?:["']?\{\}["']?)\s+(?:\+|\\;|';')$/;

/** The command-text checks (rules, recursive rm, write targets, outside searches) for one spelling of a line. */
function commandHit(cmd: string, ws: string): PrefilterHit | null {
  if (CACHE_CLEAN.test(cmd.trim())) return null;
  for (const [category, re, why] of COMMAND_RULES) if (re.test(cmd)) return { category, reason: why };
  const rm = unsafeRecursiveRm(cmd);
  if (rm) return { category: 'destructive', reason: rm };
  for (const t of commandWriteTargets(cmd)) if (outsideWrite(t, ws)) return { category: 'outside-workspace-write', reason: `writes outside the workspace: ${t}` };
  const look = outsideSearch(cmd, ws);
  if (look) return { category: 'credential-access', reason: look };
  return null;
}

/** Return the first block category this call hits, or null. Never returns "allow". */
export function prefilter(q: PrefilterQuery, workspace: string, depth = 0): PrefilterHit | null {
  const { input } = q;
  const ws = path.resolve(workspace);
  // 1. Things the policy itself says always need a human.
  const r = q.reason ?? '';
  if (/^potentially dangerous: (?:publishes|.*remote)/.test(r)) return { category: 'publishing', reason: r };
  if (/^potentially dangerous/.test(r)) return { category: /privilege/.test(r) ? 'security-weakening' : 'destructive', reason: r };
  if (/controls the agent|always need approval/.test(r)) return { category: 'security-weakening', reason: r };
  if (/may contain secrets/.test(r)) return { category: 'credential-access', reason: r };
  // a write (file tool or a shell command's write target) is an outside write; only a read is credential access
  if (/outside the workspace/.test(r)) return { category: input.paths?.some((p) => p.write) || /\bwrites? outside/.test(r) ? 'outside-workspace-write' : 'credential-access', reason: r };
  if (/tuglineignore|git-ignored/.test(r)) return { category: 'credential-access', reason: `${r} (the user hid it from the agent)` };
  if (input.forceAsk) return { category: 'credential-access', reason: input.forceAsk };
  // 2. Paths.
  for (const p of input.paths ?? []) {
    // physical spellings on both sides (macOS /var → /private/var), see physicalPath
    const abs = physicalPath(path.resolve(ws, p.path));
    const rel = path.relative(physicalPath(ws), abs).split(path.sep).join('/');
    const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
    if (SECRET_PATH.test(inside ? rel : abs)) return { category: 'credential-access', reason: `touches a secrets file: ${p.path}` };
    if (p.write && !inside) return { category: 'outside-workspace-write', reason: `writes outside the workspace: ${abs}` };
    if (p.write && PERSIST_PATH.test(inside ? rel : abs)) return { category: 'persistence', reason: `writes a file that runs code later: ${p.path}` };
    if (!inside) return { category: 'credential-access', reason: `reads outside the workspace: ${abs}` };
  }
  // 3. Shell commands.
  if (typeof input.command === 'string') {
    const cmd = input.command;
    // The raw line first, then its canonical spellings (G1): quotes/escapes stripped, wrappers
    // resolved, program names lower-cased basenames, short flags split, `--flag=value` split.
    const norm = normalizeCommand(cmd);
    for (const form of new Set([cmd, norm.kept, norm.resolved])) {
      const hit = commandHit(form, ws);
      if (hit) return hit;
    }
    if (norm.dynamic.length) return { category: 'security-weakening', reason: `program name computed at run time: ${norm.dynamic[0]}` };
    // Code inside `sh -c '…'`, `eval`, `env -S` and `$(…)` (nested to any depth) is judged like the outer command.
    if (depth < 4) {
      for (const inner of new Set([...shellCStrings(cmd), ...norm.shell])) {
        if (/\$\(|`/.test(inner)) return { category: 'security-weakening', reason: 'nested shell whose code is built by command substitution' };
        const hit = prefilter({ ...q, input: { ...input, command: inner } }, workspace, depth + 1);
        if (hit) return hit;
      }
      for (const inner of new Set(norm.subst)) {
        const hit = prefilter({ ...q, input: { ...input, command: inner } }, workspace, depth + 1);
        if (hit) return hit;
      }
    }
  }
  // 4. Network tools: data in the request.
  if (input.kind === 'network') {
    const a = (q.args ?? {}) as Record<string, unknown>;
    const method = typeof a.method === 'string' ? a.method.toUpperCase() : 'GET';
    if (!['GET', 'HEAD'].includes(method) || a.body !== undefined || a.data !== undefined) return { category: 'exfiltration', reason: `${method} request with a body` };
    const u = urlOf(a);
    if (u) {
      if (u.length > 400) return { category: 'exfiltration', reason: 'very long URL (data may be encoded in it)' };
      try {
        const url = new URL(u);
        if (/[A-Za-z0-9+/=_-]{48,}/.test(url.search + url.hash + url.pathname)) return { category: 'exfiltration', reason: 'URL carries an encoded payload' };
        if (url.username || url.password) return { category: 'credential-access', reason: 'URL embeds credentials' };
      } catch {
        /* not a URL */
      }
    }
  }
  // 5. MCP tools whose names say they change or send things.
  if (input.kind === 'mcp') {
    const name = q.tool.toLowerCase();
    if (/(delete|remove|drop|destroy|purge|wipe|truncate|kill|terminate)/.test(name)) return { category: 'destructive', reason: `MCP tool ${q.tool} looks destructive` };
    if (/(publish|deploy|release|push|merge|send|post|email|mail|message|transfer|pay|payment|create_issue|comment|share|upload|invite)/.test(name)) return { category: 'publishing', reason: `MCP tool ${q.tool} sends or publishes` };
  }
  return null;
}
