// Relevance set for scripts/search-benchmark.js. Every query names the
// endpoint (or endpoints) an agent would want back. Query types:
//   keyword     words close to the wording of the spec
//   sentence    a full natural-language request
//   paraphrase  vocabulary that differs from the spec
//   inflection  other grammatical forms of the spec's words
//   compound    camelCase or snake_case identifiers taken from client code
//   field       a parameter or property the endpoint accepts or returns
//   typo        a misspelled keyword

const GITHUB =
  "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json"
const STRIPE =
  "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json"

const ISSUES = "/repos/{owner}/{repo}/issues"
const PULLS = "/repos/{owner}/{repo}/pulls"

export const QUERY_SETS = [
  {
    name: "GitHub REST",
    source: GITHUB,
    queries: [
      { type: "keyword", query: "list repository issues", expected: [`GET ${ISSUES}`] },
      { type: "keyword", query: "create issue", expected: [`POST ${ISSUES}`] },
      { type: "keyword", query: "merge pull request", expected: [`PUT ${PULLS}/{pull_number}/merge`] },
      { type: "keyword", query: "latest release", expected: ["GET /repos/{owner}/{repo}/releases/latest"] },
      { type: "keyword", query: "list branches", expected: ["GET /repos/{owner}/{repo}/branches"] },
      { type: "keyword", query: "create fork", expected: ["POST /repos/{owner}/{repo}/forks"] },
      { type: "keyword", query: "rate limit", expected: ["GET /rate_limit"] },
      { type: "keyword", query: "list organization members", expected: ["GET /orgs/{org}/members"] },
      { type: "keyword", query: "search code", expected: ["GET /search/code"] },
      { type: "keyword", query: "create gist", expected: ["POST /gists"] },

      { type: "sentence", query: "I need to get all the open issues of a repository", expected: [`GET ${ISSUES}`] },
      { type: "sentence", query: "how do I add a comment to an issue", expected: [`POST ${ISSUES}/{issue_number}/comments`] },
      { type: "sentence", query: "get the profile of the user who is logged in", expected: ["GET /user"] },
      { type: "sentence", query: "which files were changed in a pull request", expected: [`GET ${PULLS}/{pull_number}/files`] },
      { type: "sentence", query: "I want to delete a repository", expected: ["DELETE /repos/{owner}/{repo}"] },
      { type: "sentence", query: "ask someone to review my pull request", expected: [`POST ${PULLS}/{pull_number}/requested_reviewers`] },
      { type: "sentence", query: "show me the commits of a repository", expected: ["GET /repos/{owner}/{repo}/commits"] },
      { type: "sentence", query: "trigger a workflow run manually", expected: ["POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches"] },

      { type: "paraphrase", query: "remove a member's access to a repo", expected: ["DELETE /repos/{owner}/{repo}/collaborators/{username}"] },
      { type: "paraphrase", query: "edit an issue", expected: [`PATCH ${ISSUES}/{issue_number}`] },
      { type: "paraphrase", query: "open a new PR", expected: [`POST ${PULLS}`] },
      { type: "paraphrase", query: "read a file from a repo", expected: ["GET /repos/{owner}/{repo}/contents/{path}"] },
      { type: "paraphrase", query: "bookmark a repository", expected: ["PUT /user/starred/{owner}/{repo}"] },
      { type: "paraphrase", query: "register a callback url for repository events", expected: ["POST /repos/{owner}/{repo}/hooks"] },
      { type: "paraphrase", query: "diff two commits", expected: ["GET /repos/{owner}/{repo}/compare/{basehead}"] },
      { type: "paraphrase", query: "publish a new version of the project", expected: ["POST /repos/{owner}/{repo}/releases"] },

      { type: "inflection", query: "creating issues", expected: [`POST ${ISSUES}`] },
      { type: "inflection", query: "listing branches", expected: ["GET /repos/{owner}/{repo}/branches"] },
      { type: "inflection", query: "merging pull requests", expected: [`PUT ${PULLS}/{pull_number}/merge`] },
      { type: "inflection", query: "locked issue", expected: [`PUT ${ISSUES}/{issue_number}/lock`] },
      { type: "inflection", query: "forked repositories", expected: ["GET /repos/{owner}/{repo}/forks"] },
      { type: "inflection", query: "starring a repository", expected: ["PUT /user/starred/{owner}/{repo}"] },

      { type: "compound", query: "listWorkflowRuns", expected: ["GET /repos/{owner}/{repo}/actions/runs"] },
      { type: "compound", query: "createPullRequestReview", expected: [`POST ${PULLS}/{pull_number}/reviews`] },
      { type: "compound", query: "requested_reviewers", expected: [`POST ${PULLS}/{pull_number}/requested_reviewers`, `GET ${PULLS}/{pull_number}/requested_reviewers`] },
      { type: "compound", query: "getRepoContent", expected: ["GET /repos/{owner}/{repo}/contents/{path}"] },
      { type: "compound", query: "createCommitStatus", expected: ["POST /repos/{owner}/{repo}/statuses/{sha}"] },
      { type: "compound", query: "addLabelsToIssue", expected: [`POST ${ISSUES}/{issue_number}/labels`] },

      { type: "field", query: "issues assignee milestone labels filter", expected: [`GET ${ISSUES}`] },
      { type: "field", query: "pull request draft head base", expected: [`POST ${PULLS}`] },
      { type: "field", query: "release tag_name prerelease", expected: ["POST /repos/{owner}/{repo}/releases"] },
      { type: "field", query: "commit_title merge_method", expected: [`PUT ${PULLS}/{pull_number}/merge`] },
      { type: "field", query: "webhook events content_type secret", expected: ["POST /repos/{owner}/{repo}/hooks"] },

      { type: "typo", query: "repositry issues list", expected: [`GET ${ISSUES}`] },
      { type: "typo", query: "merge pul request", expected: [`PUT ${PULLS}/{pull_number}/merge`] },
      { type: "typo", query: "create relase", expected: ["POST /repos/{owner}/{repo}/releases"] },
      { type: "typo", query: "list colaborators", expected: ["GET /repos/{owner}/{repo}/collaborators"] },
      { type: "typo", query: "workflow dispach", expected: ["POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches"] },
    ],
  },
  {
    name: "Stripe",
    source: STRIPE,
    queries: [
      { type: "keyword", query: "create customer", expected: ["POST /v1/customers"] },
      { type: "keyword", query: "list charges", expected: ["GET /v1/charges"] },
      { type: "keyword", query: "confirm payment intent", expected: ["POST /v1/payment_intents/{intent}/confirm"] },
      { type: "keyword", query: "create refund", expected: ["POST /v1/refunds"] },
      { type: "keyword", query: "retrieve balance", expected: ["GET /v1/balance"] },
      { type: "keyword", query: "finalize invoice", expected: ["POST /v1/invoices/{invoice}/finalize"] },
      { type: "keyword", query: "create checkout session", expected: ["POST /v1/checkout/sessions"] },
      { type: "keyword", query: "search customers", expected: ["GET /v1/customers/search"] },

      { type: "sentence", query: "I need to charge a customer for an order", expected: ["POST /v1/payment_intents"] },
      { type: "sentence", query: "how do I cancel a subscription", expected: ["DELETE /v1/subscriptions/{subscription_exposed_id}"] },
      { type: "sentence", query: "give the money back to the customer", expected: ["POST /v1/refunds"] },
      { type: "sentence", query: "get the details of one customer", expected: ["GET /v1/customers/{customer}"] },
      { type: "sentence", query: "send money to my bank account", expected: ["POST /v1/payouts"] },
      { type: "sentence", query: "save a card to a customer for later", expected: ["POST /v1/payment_methods/{payment_method}/attach", "POST /v1/setup_intents"] },

      { type: "paraphrase", query: "remove a customer", expected: ["DELETE /v1/customers/{customer}"] },
      { type: "paraphrase", query: "register a webhook url", expected: ["POST /v1/webhook_endpoints"] },
      { type: "paraphrase", query: "add a discount code", expected: ["POST /v1/coupons", "POST /v1/promotion_codes"] },
      { type: "paraphrase", query: "start a recurring plan for a customer", expected: ["POST /v1/subscriptions"] },
      { type: "paraphrase", query: "mark an invoice as uncollectible or void it", expected: ["POST /v1/invoices/{invoice}/void", "POST /v1/invoices/{invoice}/mark_uncollectible"] },
      { type: "paraphrase", query: "hosted payment page link", expected: ["POST /v1/payment_links", "POST /v1/checkout/sessions"] },

      { type: "inflection", query: "capturing a payment intent", expected: ["POST /v1/payment_intents/{intent}/capture"] },
      { type: "inflection", query: "refunded charges", expected: ["POST /v1/refunds", "GET /v1/refunds"] },
      { type: "inflection", query: "paying an invoice", expected: ["POST /v1/invoices/{invoice}/pay"] },
      { type: "inflection", query: "canceled payment intents", expected: ["POST /v1/payment_intents/{intent}/cancel"] },
      { type: "inflection", query: "creating products", expected: ["POST /v1/products"] },

      { type: "compound", query: "paymentIntents", expected: ["POST /v1/payment_intents", "GET /v1/payment_intents"] },
      { type: "compound", query: "webhookEndpoints create", expected: ["POST /v1/webhook_endpoints"] },
      { type: "compound", query: "setup_intents", expected: ["POST /v1/setup_intents", "GET /v1/setup_intents"] },
      { type: "compound", query: "createPaymentLink", expected: ["POST /v1/payment_links"] },
      { type: "compound", query: "listBalanceTransactions", expected: ["GET /v1/balance_transactions"] },

      { type: "field", query: "payment intent amount currency capture_method", expected: ["POST /v1/payment_intents"] },
      { type: "field", query: "price unit_amount recurring interval", expected: ["POST /v1/prices"] },
      { type: "field", query: "checkout success_url line_items", expected: ["POST /v1/checkout/sessions"] },
      { type: "field", query: "coupon percent_off duration", expected: ["POST /v1/coupons"] },
      { type: "field", query: "refund reason payment_intent", expected: ["POST /v1/refunds"] },

      { type: "typo", query: "create custmer", expected: ["POST /v1/customers"] },
      { type: "typo", query: "payment intnet confirm", expected: ["POST /v1/payment_intents/{intent}/confirm"] },
      { type: "typo", query: "list subscritions", expected: ["GET /v1/subscriptions"] },
      { type: "typo", query: "create invocie", expected: ["POST /v1/invoices"] },
      { type: "typo", query: "retreive balance", expected: ["GET /v1/balance"] },
    ],
  },
]
