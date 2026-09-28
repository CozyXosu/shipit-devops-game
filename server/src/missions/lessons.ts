// Teaching content for file-authoring missions. A lesson explains the file
// format the mission asks the player to write (YAML, Dockerfile, nginx conf,
// HCL, …) BEFORE the player has to write it. Lessons are free — reading one
// never costs a hint or rating, unlike the progressive hints.
//
// The annotated examples intentionally use the real values that pass the
// mission checks: at this stage of the game, copying-with-understanding IS
// the learning objective. Starters are commented TODO scaffolds — every
// parser in sim/ skips '#' comments, so a saved-but-unfilled starter never
// falsely passes a requirement (exceptions: nginx + logrotate are parsed as
// raw text, so those two starters use prose-only TODOs).

export interface LessonRow { term: string; text: string }
export interface LessonExample { label: string; code: string }

export interface Lesson {
  /** What this format is and why the industry uses it (plain prose). */
  intro: string;
  /** Cheat-sheet: the syntax you type → what it means. */
  syntax?: LessonRow[];
  /** Annotated examples — code with inline comments explaining the lines. */
  examples?: LessonExample[];
  /** Where the file(s) live and how to create them in the game. */
  where?: string;
  /** Commented TODO scaffold the player can open in the EDITOR. */
  starter?: { path: string; content: string };
}

const lines = (...ls: string[]) => ls.join('\n');

export const LESSONS: Record<string, Lesson> = {
  // ------------------------------------------------------------- m04
  'm04-nginx': {
    intro: 'nginx is a reverse proxy — the receptionist that owns the front door (port 80) and forwards visitors to your app (port 8080), so the app never has to be privileged or face the internet itself. Its config is plain text: directives end with a semicolon, related directives are grouped in { } blocks, and lines starting with # are comments.',
    syntax: [
      { term: 'server { … }', text: 'one virtual website: what to listen on and how to answer' },
      { term: 'listen 80;', text: 'the port nginx answers on (80 = standard web traffic)' },
      { term: 'server_name _;', text: 'which hostname this server answers for (_ = any of them)' },
      { term: 'location / { … }', text: 'rules for a URL prefix — / matches every URL' },
      { term: 'proxy_pass http://…;', text: 'forward the request to another address instead of serving a file yourself' },
      { term: 'nginx -t', text: 'test the config for syntax errors BEFORE restarting — always run this first' }
    ],
    examples: [{
      label: 'A reverse-proxy site config, line by line',
      code: lines(
        'server {                              # one website',
        '  listen 80;                          # answer the standard web port',
        '  server_name _;                      # any hostname the customer typed',
        '  location / {                        # for every URL…',
        '    proxy_pass http://127.0.0.1:8080; # …hand the request to the API on this machine',
        '  }',
        '}'
      )
    }],
    where: '/etc/nginx/sites-enabled/acme.conf — EDITOR → ＋ New file, or open the starter below. After saving: sudo systemctl enable nginx && sudo systemctl start nginx, then sudo ufw allow 80/tcp.',
    starter: {
      path: '/etc/nginx/sites-enabled/acme.conf',
      content: lines(
        '# Reverse proxy: nginx answers the front door, your app answers',
        '# on 8080. Fill in each TODO with a real directive, delete these',
        '# comment lines, SAVE, then start nginx and open the firewall.',
        '',
        'server {',
        '  # TODO 1: make nginx answer the standard web port (a listen directive).',
        '',
        '  server_name _;',
        '',
        '  location / {',
        '    # TODO 2: forward every request to the API on this same machine,',
        '    # port 8080 (a proxy_pass directive — do not forget the semicolon).',
        '  }',
        '}'
      )
    }
  },

  // ------------------------------------------------------------- m06
  'm06-git': {
    intro: '.gitignore is a plain text list of files git should never track — one pattern per line, living in the repo root. Commit it like any other file so every clone gets the same rules. The point: git history is forever, so anything rebuildable or secret should stay out of it.',
    syntax: [
      { term: 'node_modules/', text: 'a trailing / matches a directory — dependencies are huge and rebuildable' },
      { term: '.env', text: 'an exact filename — secrets must never enter history (they cannot truly be removed later)' },
      { term: '*.log', text: '* is a wildcard — matches any file ending in .log' },
      { term: '# a line', text: 'a comment, for humans only' }
    ],
    examples: [{
      label: 'A typical Node.js .gitignore',
      code: lines(
        'node_modules/  # rebuildable with npm install',
        '.env           # secrets stay on the machine they belong to',
        '*.log          # logs are runtime noise, not source'
      )
    }],
    where: '/opt/app/.gitignore — EDITOR → ＋ New file. Then: git add -A && git commit -m "ignore build junk and secrets".'
  },

  // ------------------------------------------------------------- m07
  'm07-branch': {
    intro: 'When two branches change the same lines of a file, git cannot guess the merged result — so it stops the merge and writes BOTH versions into the file, fenced by conflict markers. Resolving the conflict means editing the file down to the one version that keeps both intents, then committing.',
    syntax: [
      { term: '<<<<<<< HEAD', text: 'below this line: YOUR version (the branch you are on)' },
      { term: '=======', text: 'the fence — your version above, theirs below' },
      { term: '>>>>>>> main', text: 'above this line: THEIR version (the branch you merged in)' },
      { term: 'resolving', text: 'delete all three markers and keep the final text you actually want — usually both changes, merged by hand' }
    ],
    examples: [{
      label: 'A conflict, then its resolution',
      code: lines(
        '<<<<<<< HEAD',
        '  apiTimeout: 30,      # you raised the timeout',
        '=======',
        '  retryMax: 5,         # Jaime hardened the retries',
        '>>>>>>> main',
        '',
        '— after you edit the file (both changes kept, markers gone) —',
        '',
        '  apiTimeout: 60,',
        '  retryMax: 5,'
      )
    }],
    where: 'Open /opt/app/config.js in the EDITOR — the markers are already in the file. After editing: git add config.js && git commit.'
  },

  // ------------------------------------------------------------- m08
  'm08-secrets': {
    intro: 'The fix has three parts, two of them files. (1) .env — a KEY=value file that lives on the server and never enters git. (2) config.js — reads the secret from the environment instead of hard-coding it. (3) the systemd unit — tells the service to load .env at start.',
    syntax: [
      { term: 'DB_PASSWORD=…', text: 'one setting per line: no spaces around =, no quotes needed' },
      { term: '# a line', text: 'comment, ignored' },
      { term: 'process.env.DB_PASSWORD', text: 'how Node.js reads an environment variable at runtime' },
      { term: '[Service]', text: 'the section of a systemd unit describing the process itself' },
      { term: 'EnvironmentFile=…', text: 'systemd directive: load a KEY=value file into the service\u2019s environment' }
    ],
    examples: [
      {
        label: '/opt/app/.env (new file)',
        code: lines(
          '# secrets for the API — this file must be in .gitignore',
          'DB_PASSWORD=b1gmeter-prod-2024'
        )
      },
      {
        label: '/etc/systemd/system/api.service (add one line inside [Service])',
        code: lines(
          '[Service]',
          'EnvironmentFile=/opt/app/.env'
        )
      }
    ],
    where: '/opt/app/.env — EDITOR → ＋ New file. config.js and the unit file already exist: open them in the EDITOR and edit. After the unit change: sudo systemctl daemon-reload && sudo systemctl restart api.'
  },

  // ------------------------------------------------------------- m09
  'm09-docker': {
    intro: 'A Dockerfile is the recipe for a container image: a plain text file of instructions, run top to bottom, each adding a layer to the image. A container is a running copy of that image — app + runtime + nothing else. Build the recipe once, and the identical result runs anywhere.',
    syntax: [
      { term: 'FROM image', text: 'the starting layer: a prebuilt base image with OS + runtime. node:20-alpine = Node 20 on tiny Alpine Linux' },
      { term: 'WORKDIR /app', text: 'sets the current directory inside the image for every instruction after it' },
      { term: 'COPY . .', text: 'copies files from your folder (the build context) into the image' },
      { term: 'RUN command', text: 'executes a command AT BUILD TIME and bakes the result into a layer' },
      { term: 'USER node', text: 'everything after this runs as that user — images default to root, and root inside a container is still too much power' },
      { term: 'EXPOSE 8080', text: 'documentation: which port the app listens on, so operators can find it' },
      { term: 'HEALTHCHECK CMD …', text: 'how Docker periodically asks "are you actually serving?" — failing containers get flagged unhealthy' },
      { term: 'CMD ["node", "server.js"]', text: 'what the container runs when it starts. JSON-array form avoids shell quirks' }
    ],
    examples: [{
      label: 'A production Dockerfile, line by line',
      code: lines(
        'FROM node:20-alpine                  # base: Node 20 on Alpine (~50 MB)',
        'WORKDIR /app                         # everything below happens in /app',
        'COPY . .                             # your source, into the image',
        'RUN npm install --omit=dev           # dependencies only — no dev tools in prod',
        'USER node                            # drop root: run as the built-in "node" user',
        'EXPOSE 8080                          # the port the API listens on',
        'HEALTHCHECK CMD wget -qO- http://localhost:8080/health || exit 1',
        'CMD ["node", "server.js"]            # runs when the container starts'
      )
    }],
    where: '/opt/app/Dockerfile — EDITOR → ＋ New file (or the starter below). Build from /opt/app: docker build -t acme/api:v1 . — then run it: docker run -d --name api -p 8080:8080 acme/api:v1 (stop the systemd service first).',
    starter: {
      path: '/opt/app/Dockerfile',
      content: lines(
        '# Dockerfile = the recipe for your container image.',
        '# Fill in every TODO, delete the comment lines you no longer need,',
        '# SAVE, then build and run:',
        '#   docker build -t acme/api:v1 .',
        '#   docker run -d --name api -p 8080:8080 acme/api:v1',
        '',
        '# TODO 1: the base image — Node 20 on Alpine Linux is a good small start',
        '# FROM node:20-alpine',
        '',
        'WORKDIR /app',
        'COPY . .',
        'RUN npm install --omit=dev',
        '',
        '# TODO 2: stop running as root — the base image ships a built-in user',
        '# called "node". One USER instruction, no build needed.',
        '# USER node',
        '',
        '# TODO 3: document the port the API listens on (check the requirements list)',
        '# EXPOSE 8080',
        '',
        '# TODO 4: teach Docker to check /health over HTTP: wget -qO- … || exit 1',
        '# HEALTHCHECK CMD wget -qO- http://localhost:8080/health || exit 1',
        '',
        '# TODO 5: the start command, JSON-array style: ["node", "server.js"]',
        '# CMD ["node", "server.js"]'
      )
    }
  },

  // ------------------------------------------------------------- m10
  'm10-ci': {
    intro: 'YAML is the config format of CI — and of most of DevOps. It is just structured text a machine reads: settings as key: value, grouping by indentation, lists with dashes. A pipeline file says: a name, when to run (on: push), and a list of steps under steps:. Each step is a list item with a name and either run: (a shell command) or uses: (a built-in action).',
    syntax: [
      { term: 'key: value', text: 'a setting — the colon + space is what makes it YAML' },
      { term: 'indentation', text: '2 spaces per level = "belongs to the line above". NEVER tabs — tabs are a YAML syntax error' },
      { term: '- item', text: 'a dash starts a list entry; every step is one' },
      { term: '# a line', text: 'comment, ignored' },
      { term: 'on: push', text: 'trigger: run automatically when commits are pushed' },
      { term: 'run: npm test', text: 'this step executes a shell command' },
      { term: 'uses: git/checkout', text: 'this step runs a built-in action instead of a raw command' }
    ],
    examples: [{
      label: 'A full pipeline, line by line',
      code: lines(
        'name: deploy                     # what this pipeline is called',
        'on: push                         # run it on every push',
        'steps:                           # the list of steps, in order',
        '  - name: checkout               # ← 2-space indent + dash = one list item',
        '    uses: git/checkout           #   built-in: fetch the committed code',
        '  - name: test',
        '    run: npm test                #   shell command: the test suite',
        '  - name: build',
        '    run: npm run build',
        '  - name: docker_build',
        '    run: docker build -t registry.acme.dev/acme/api:v1 .',
        '  - name: push',
        '    run: docker push registry.acme.dev/acme/api:v1',
        '  - name: deploy',
        '    uses: sim/deploy             #   built-in: ship the pushed image'
      )
    }],
    where: '/opt/app/.ci/pipeline.yml — EDITOR → ＋ New file, then commit it: git add .ci/pipeline.yml && git commit -m "add pipeline". Run it in the CI tab.',
    starter: {
      path: '/opt/app/.ci/pipeline.yml',
      content: lines(
        '# CI pipeline = the list of steps a robot runs on every push.',
        '# YAML rules: 2 spaces per indent level (never tabs), "- " starts a',
        '# list item, "# comments are ignored. Fill in the TODOs as list items',
        '# under steps:, SAVE, commit, then press RUN PIPELINE in the CI tab.',
        '',
        'name: deploy',
        'on: push',
        '',
        'steps:',
        '  # TODO 1: first step always fetches the code (built-in: git/checkout)',
        '',
        '  # TODO 2: run the test suite (shell command: npm test)',
        '',
        '  # TODO 3: build the release (npm run build)',
        '  # TODO 4: build the image  (docker build -t registry.acme.dev/acme/api:v1 .)',
        '  # TODO 5: push the image   (docker push registry.acme.dev/acme/api:v1)',
        '  # TODO 6: deploy it        (built-in: sim/deploy)'
      )
    }
  },

  // ------------------------------------------------------------- m13
  'm13-disk': {
    intro: 'logrotate is Linux\u2019s janitor: it reads policy files in /etc/logrotate.d/ and periodically archives and deletes old logs so no log grows forever. A policy is just a file path in braces followed by directives — no colons, no equals signs.',
    syntax: [
      { term: '/var/log/app.log { … }', text: 'the block applies to this log file' },
      { term: 'daily / weekly', text: 'how often to rotate (archive the old file, start a fresh one)' },
      { term: 'rotate 7', text: 'keep the last 7 rotated copies, then delete older ones' },
      { term: 'compress', text: 'gzip the rotated files — logs compress roughly 20×' },
      { term: 'missingok', text: 'don\u2019t error if the log file doesn\u2019t exist yet' },
      { term: 'notifempty', text: 'don\u2019t rotate an empty file' }
    ],
    examples: [{
      label: 'A logrotate policy, line by line',
      code: lines(
        '/var/log/app.log {  # the file this policy governs',
        '  daily             # archive it once a day…',
        '  rotate 7          # …keep a week of history, then delete',
        '  compress          # old copies take ~5% of the space',
        '  missingok         # stay calm if the file is absent',
        '  notifempty        # rotating an empty file is pointless',
        '}'
      )
    }],
    where: '/etc/logrotate.d/acme-api — EDITOR → ＋ New file. The system picks the policy up automatically within a few sim minutes.',
    starter: {
      path: '/etc/logrotate.d/acme-api',
      content: lines(
        '# logrotate policy: teach the janitor about /var/log/app.log.',
        '# Fill in each TODO with a directive, delete these comments, SAVE.',
        '# How often should it rotate, and how many old copies to keep?',
        '',
        '/var/log/app.log {',
        '  # TODO 1: rotation frequency — daily or weekly?',
        '',
        '  # TODO 2: how many old copies to keep before deleting?',
        '',
        '  compress',
        '  missingok',
        '  notifempty',
        '}'
      )
    }
  },

  // ------------------------------------------------------------- m17
  'm17-e2e': {
    intro: 'You already have a pipeline from mission 10 — this mission inserts proof between "it builds" and "users get it". Deploy to a staging environment (a production copy no customer depends on), run e2e tests against it like a real user, and require a human approval before production. The order of the steps IS the whole idea.',
    syntax: [
      { term: 'uses: sim/deploy-staging', text: 'built-in: deploy the new image to the staging environment' },
      { term: 'run: npm run e2e', text: 'end-to-end suite: drives the app like a real user would, against staging' },
      { term: 'uses: sim/approval', text: 'built-in: pause the run until a human approves it in the CI tab' },
      { term: 'fail → stop', text: 'if e2e fails, the run stops right there — the bad release never reaches the deploy step' }
    ],
    examples: [{
      label: 'The gated order: build → push → STAGING → E2E → APPROVAL → prod',
      code: lines(
        'steps:',
        '  - name: checkout',
        '    uses: git/checkout',
        '  - name: test',
        '    run: npm test',
        '  - name: build',
        '    run: npm run build',
        '  - name: docker_build',
        '    run: docker build -t registry.acme.dev/acme/api:v1 .',
        '  - name: push',
        '    run: docker push registry.acme.dev/acme/api:v1',
        '  - name: deploy_staging      # rehearsal: real deploy, zero customers',
        '    uses: sim/deploy-staging',
        '  - name: e2e                 # prove it works the way a user sees it',
        '    run: npm run e2e',
        '  - name: approve             # a human signs off',
        '    uses: sim/approval',
        '  - name: deploy              # only now: production',
        '    uses: sim/deploy'
      )
    }],
    where: 'Edit the existing /opt/app/.ci/pipeline.yml in the EDITOR (open the .ci folder under /opt/app), commit, then RUN PIPELINE in the CI tab.'
  },

  // ------------------------------------------------------------- m18
  'm18-terraform': {
    intro: 'Terraform turns infrastructure into a text file: you describe what SHOULD exist, and terraform makes reality match the file. The language is HCL — blocks with a type and a name, arguments inside braces. The file is main.tf; the workflow is init → plan (preview the diff) → apply (act). Resources that already exist get adopted with terraform import.',
    syntax: [
      { term: 'provider "stratus" { … }', text: 'which cloud to talk to, and in which region' },
      { term: 'resource "stratus_vm" "web-01" { … }', text: 'one thing that should exist: type stratus_vm, its own name web-01' },
      { term: 'size = "m3.medium"', text: 'an argument: key = value (equals sign, quoted strings)' },
      { term: '# a line', text: 'comment, ignored' },
      { term: 'terraform init', text: 'prepare the directory — run once' },
      { term: 'terraform plan', text: 'PREVIEW: file vs reality. Read it before acting' },
      { term: 'terraform import type.name id', text: 'adopt something that already exists into the file\u2019s management' },
      { term: 'terraform apply', text: 'make reality match the file' }
    ],
    examples: [{
      label: 'main.tf describing this company, line by line',
      code: lines(
        'provider "stratus" {              # our cloud provider',
        '  region = "us-east-1"',
        '}',
        '',
        'resource "stratus_vm" "web-01" {  # a VM named web-01',
        '  size = "m3.medium"              # its size — must match what really exists',
        '}',
        '',
        'resource "stratus_vm" "vm-02" {   # the second VM (from m16)',
        '  size = "m3.medium"',
        '}',
        '',
        'resource "stratus_lb" "lb01" { }  # the load balancer (no arguments needed)',
        '',
        'resource "stratus_db" "main" {    # the managed Postgres',
        '  plan = "db.small"',
        '}'
      )
    }],
    where: '/opt/infra/main.tf — EDITOR → ＋ New file, then: cd /opt/infra && terraform init && terraform plan. Import what plan lists, e.g. terraform import stratus_vm.web-01 i-web01.',
    starter: {
      path: '/opt/infra/main.tf',
      content: lines(
        '# Describe what SHOULD exist. Sizes and plans must match the real',
        '# cloud — otherwise terraform plan will want to change things.',
        '',
        '# TODO 1: a provider block for "stratus" with region = "us-east-1"',
        '',
        '# TODO 2: resource "stratus_vm" "web-01" with size = "m3.medium"',
        '# TODO 3: resource "stratus_vm" "vm-02"  with size = "m3.medium"',
        '# TODO 4: resource "stratus_lb" "lb01"   (an empty block is fine)',
        '# TODO 5: resource "stratus_db" "main"   with plan = "db.small"',
        '',
        '# Then: cd /opt/infra && terraform init && terraform plan',
        '# plan lists what needs IMPORTing, e.g.:',
        '#   terraform import stratus_vm.web-01 i-web01'
      )
    }
  },

  // ------------------------------------------------------------- m19
  'm19-k8s': {
    intro: 'A Kubernetes manifest is a YAML file describing an object you want to exist: "keep 2 copies of this container alive and load-balanced". You never say HOW — the cluster continuously forces reality to match your file. Every object has the same four top-level keys: apiVersion, kind, metadata, spec. (YAML refresher from mission 10: 2-space indents, never tabs; "- " starts a list item.)',
    syntax: [
      { term: 'apiVersion: apps/v1', text: 'which API family the object type lives in (v1 = old core, apps/v1 = workloads, networking.k8s.io/v1 = routing)' },
      { term: 'kind: Deployment', text: 'what kind of object: Deployment, Service, Ingress…' },
      { term: 'metadata: / name: api', text: 'the object\u2019s name (and labels)' },
      { term: 'spec:', text: 'the desired state — everything nested under here IS the request' },
      { term: 'replicas: 2', text: 'keep 2 identical pods; if one dies, the cluster makes another' },
      { term: 'selector.matchLabels', text: 'which pods belong to this Deployment — MUST match template.labels below' },
      { term: 'template:', text: 'the cookie cutter: what each pod contains' },
      { term: 'readinessProbe', text: '"can you serve traffic YET?" — a pod that fails it gets no traffic' },
      { term: 'livenessProbe', text: '"are you alive at all?" — a container that fails it gets restarted' },
      { term: 'type: LoadBalancer', text: 'a Service with an external IP, spreading traffic over matching pods' },
      { term: 'Ingress', text: 'the HTTP router: hostname + path → service' }
    ],
    examples: [
      {
        label: 'k8s/deployment.yaml — keep the app alive',
        code: lines(
          'apiVersion: apps/v1',
          'kind: Deployment             # "keep N copies of this pod running"',
          'metadata:',
          '  name: api',
          'spec:',
          '  replicas: 2                # two identical pods — no single point of failure',
          '  selector:',
          '    matchLabels:',
          '      app: api               # which pods are mine (must match labels below)',
          '  template:                  # the cookie cutter for each pod',
          '    metadata:',
          '      labels:',
          '        app: api             # the selector matches THIS',
          '    spec:',
          '      containers:',
          '        - name: api',
          '          image: registry.acme.dev/acme/api:v1   # what to run',
          '          ports:',
          '            - containerPort: 8080   # the port the app listens on',
          '          readinessProbe:    # route traffic only once this passes',
          '            httpGet: { path: /health, port: 8080 }',
          '          livenessProbe:     # restart the container if this keeps failing',
          '            httpGet: { path: /health, port: 8080 }'
        )
      },
      {
        label: 'k8s/service.yaml — one stable address for the pods',
        code: lines(
          'apiVersion: v1',
          'kind: Service               # a stable network name for the pods',
          'metadata:',
          '  name: api',
          'spec:',
          '  type: LoadBalancer        # reachable from outside the cluster',
          '  selector:',
          '    app: api                # balances over pods carrying this label',
          '  ports:',
          '    - port: 80              # what callers connect to…',
          '      targetPort: 8080      # …forwarded to the pod\u2019s port'
        )
      },
      {
        label: 'k8s/ingress.yaml — the HTTP front door',
        code: lines(
          'apiVersion: networking.k8s.io/v1',
          'kind: Ingress              # routes host + path → service',
          'metadata:',
          '  name: api',
          'spec:',
          '  rules:',
          '    - host: api.{domain}   # requests for this hostname…',
          '      http:',
          '        paths:',
          '          - path: /         # …at any path…',
          '            pathType: Prefix',
          '            backend:',
          '              service:',
          '                name: api    # …go to the Service named "api"…',
          '                port: 80    # …on its port 80'
        )
      }
    ],
    where: 'Three files under /opt/app/k8s/ — deployment.yaml, service.yaml, ingress.yaml — EDITOR → ＋ New file (once per file). Then from /opt/app: kubectl apply -f k8s/',
    starter: {
      path: '/opt/app/k8s/deployment.yaml',
      content: lines(
        '# A Deployment = "keep N copies of this container alive".',
        '# YAML rules: 2-space indents (never tabs), key: value, "- " = list item.',
        '# Fill the TODOs, delete comments you don\u2019t need, SAVE — then create',
        '# service.yaml and ingress.yaml (copy them from the lesson examples),',
        '# and run: kubectl apply -f k8s/',
        '',
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: api',
        'spec:',
        '  # TODO 1: how many copies? (the mission wants no single point of failure)',
        '  # replicas: 2',
        '',
        '  selector:',
        '    matchLabels:',
        '      app: api',
        '  template:',
        '    metadata:',
        '      labels:',
        '        app: api            # must match matchLabels above',
        '    spec:',
        '      containers:',
        '        - name: api',
        '          # TODO 2: which image? (you pushed it to the registry in m10)',
        '          # image: registry.acme.dev/acme/api:v1',
        '          ports:',
        '            - containerPort: 8080',
        '          # TODO 3: readiness probe — httpGet /health on port 8080',
        '          # readinessProbe:',
        '          #   httpGet: { path: /health, port: 8080 }',
        '          # TODO 4: liveness probe — same check, different meaning:',
        '          # failing it restarts the container',
        '          # livenessProbe:',
        '          #   httpGet: { path: /health, port: 8080 }'
      )
    }
  },

  // ------------------------------------------------------------- m34
  'm34-zerotrust': {
    intro: 'A NetworkPolicy is a firewall rule for pods, written as a Kubernetes manifest. Cluster networks are open by default — every pod can talk to every pod. The zero-trust pattern is two policies: one that denies everything, then one per allowed connection. Both can live in one file, separated by ---. (YAML refresher: 2-space indents, never tabs.)',
    syntax: [
      { term: 'podSelector: {}', text: 'an EMPTY selector = this policy applies to EVERY pod — that is the default-deny' },
      { term: 'policyTypes: [Ingress]', text: 'this policy governs incoming connections' },
      { term: '---', text: 'separates two YAML documents in one file' },
      { term: 'ingress: - from: …', text: 'the allowlist: only connections matching this get through' },
      { term: 'from: podSelector.matchLabels', text: 'only pods carrying this label may connect' },
      { term: 'ports: - port: 5432', text: '…and only on this port' },
      { term: 'securityContext:', text: 'per-container safety settings, inside the container spec of a Deployment' },
      { term: 'runAsNonRoot: true', text: 'refuse to start the container as UID 0' }
    ],
    examples: [{
      label: 'netpol.yaml — deny all, then allow exactly one thing',
      code: lines(
        '# Document 1: deny everything…',
        'apiVersion: networking.k8s.io/v1',
        'kind: NetworkPolicy',
        'metadata:',
        '  name: default-deny',
        'spec:',
        '  podSelector: {}            # empty selector = every pod',
        '  policyTypes:',
        '    - Ingress                # governs all incoming traffic',
        '---',
        '# Document 2: …then allow exactly one connection',
        'apiVersion: networking.k8s.io/v1',
        'kind: NetworkPolicy',
        'metadata:',
        '  name: allow-api-to-db',
        'spec:',
        '  podSelector:',
        '    matchLabels:',
        '      app: db                # this rule guards the database…',
        '  ingress:',
        '    - from:',
        '        - podSelector:',
        '            matchLabels:',
        '              app: api       # …only the api pod may connect…',
        '      ports:',
        '        - port: 5432         # …and only on Postgres\u2019s port'
      )
    }],
    where: '/opt/app/k8s/netpol.yaml — EDITOR → ＋ New file, then kubectl apply -f k8s/. For non-root: edit the existing k8s/deployment.yaml and add securityContext inside the container spec, then re-apply.',
    starter: {
      path: '/opt/app/k8s/netpol.yaml',
      content: lines(
        '# Zero trust in two documents ("---" separates YAML documents):',
        '#   1) deny ALL incoming traffic, for every pod',
        '#   2) allow exactly one connection: api → db on port 5432',
        '# Fill the TODOs, SAVE, then: kubectl apply -f k8s/',
        '',
        'apiVersion: networking.k8s.io/v1',
        'kind: NetworkPolicy',
        'metadata:',
        '  name: default-deny',
        'spec:',
        '  # TODO 1: select EVERY pod (hint: an empty {} selector means "all")',
        '  # podSelector: {}',
        '  policyTypes:',
        '    - Ingress',
        '---',
        'apiVersion: networking.k8s.io/v1',
        'kind: NetworkPolicy',
        'metadata:',
        '  name: allow-api-to-db',
        'spec:',
        '  podSelector:',
        '    matchLabels:',
        '      app: db               # this rule guards the database',
        '  ingress:',
        '    - from:',
        '        - podSelector:',
        '            matchLabels:',
        '              # TODO 2: which pod is allowed to connect?',
        '              # app: api',
        '      ports:',
        '        # TODO 3: which port does Postgres listen on?',
        '        # - port: 5432'
      )
    }
  },

  // ------------------------------------------------------------- m35
  'm35-supplychain': {
    intro: 'Admission control is the cluster\u2019s bouncer: before any object gets created, every Policy manifest on the cluster gets a vote. Your policy says "images must be signed" — from then on, an unsigned image physically cannot roll out, no matter who asks. cosign is the signing tool; an SBOM attestation lists every package inside the image.',
    syntax: [
      { term: 'apiVersion: policy.shipit.dev/v1', text: 'a custom resource this cluster understands' },
      { term: 'kind: Policy', text: 'an admission rule object' },
      { term: 'requireSignedImages: true', text: 'the rule: reject any image without a cosign signature' },
      { term: 'cosign sign <image>', text: 'cryptographically sign a registry image (the key lives in your vault)' },
      { term: 'cosign attest --type sbom <image>', text: 'attach the software bill of materials: every package inside' }
    ],
    examples: [{
      label: 'policy.yaml, line by line',
      code: lines(
        'apiVersion: policy.shipit.dev/v1',
        'kind: Policy                    # an admission rule',
        'metadata:',
        '  name: require-signed-images',
        'spec:',
        '  requireSignedImages: true     # unsigned images are rejected at the door'
      )
    }],
    where: '/opt/app/k8s/policy.yaml — EDITOR → ＋ New file, then kubectl apply -f k8s/ and kubectl get policy.',
    starter: {
      path: '/opt/app/k8s/policy.yaml',
      content: lines(
        '# An admission Policy: the cluster rejects anything this rule',
        '# forbids, before it is even created. Fill in the TODO, SAVE, then:',
        '#   kubectl apply -f k8s/ && kubectl get policy',
        '',
        'apiVersion: policy.shipit.dev/v1',
        'kind: Policy',
        'metadata:',
        '  name: require-signed-images',
        'spec:',
        '  # TODO: require signed images (a boolean argument)',
        '  # requireSignedImages: true'
      )
    }
  },

  // ------------------------------------------------------------- m38
  'm38-previews': {
    intro: 'A preview environment is a whole private copy of the app that exists only for one CI run — build it, share the URL, let it vanish. No tickets, no shared staging queue. Adding it to your pipeline is one step. (Pipeline YAML refresher from mission 10: steps are "- name:" list items with uses: or run:.)',
    syntax: [
      { term: 'uses: sim/preview', text: 'built-in: spins up an ephemeral environment for this run and prints its URL' },
      { term: 'pr-N.preview.{domain}', text: 'each run gets its own hostname — N is the run number' },
      { term: 'auto-destroy', text: 'previews tear themselves down after 120 sim minutes' }
    ],
    examples: [{
      label: 'The step, in context',
      code: lines(
        'steps:',
        '  - name: push',
        '    run: docker push registry.acme.dev/acme/api:v1',
        '  - name: preview          # ← add exactly this step after push',
        '    uses: sim/preview',
        '  - name: deploy',
        '    uses: sim/deploy'
      )
    }],
    where: 'Edit the existing /opt/app/.ci/pipeline.yml (EDITOR → /opt/app → .ci folder), commit, then RUN PIPELINE twice.'
  }
};
