const github = require("@actions/github");
const core = require("@actions/core");

async function run() {
    const secretToken = core.getInput("secret-token");
    const epicPrefix = core.getInput("epic-prefix");
    const octokit = new github.GitHub(secretToken);
    const context = github.context;

    // Safety check - only act on issues
    var sourceIssue = context.payload.issue
    if (!sourceIssue) {
        return;
    }

    /*
     * The issue may be an Epic that has been created / updated, in which case we reformat the 'Workload' section to
     * include issue titles etc.
     *
     * It may also be a normal issue that is referenced within an Epic - in that case we just update the corresponding
     * entry in the 'Workload' section, marking the task as complete, abandoned etc.
     *
     * Check the issue title to find out which is the case, using 'epicPrefix' to identify the issue as an actual Epic.
     */
    if (sourceIssue.title.startsWith(epicPrefix))
        updateEpic(octokit, sourceIssue);
    }
    else
    {
    }
}

// Update Epic issue
async function updateEpic(octokit, issue) {
    console.log("Updating Epic issue '" + issue.title + "'...");
    console.log("  -- Issue number is " + issue.number);
    console.log("  -- Issue body is '" + issue.body + "'");
}

// Run the action
run()
