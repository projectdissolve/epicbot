const github = require("@actions/github");
const core = require("@actions/core");

async function run() {
    const secretToken = core.getInput("secret-token");
    const epicPrefix = core.getInput("epic-prefix");
    const octokit = new github.getOctokit(secretToken);
    const context = github.context;

    // Safety check - only act on issues
    var sourceIssue = context.payload.issue
    if (!sourceIssue)
        return;

    /*
     * The issue may be an Epic that has been created / updated, in which case we
     * reformat the 'Workload' section to include issue titles etc.
     *
     * It may also be a normal issue that is referenced within an Epic - in that
     * case we just update the corresponding entry in the 'Workload' section,
     * marking the task as complete, abandoned etc.
     *
     * Check the issue title to find out which is the case, using 'epicPrefix' to
     * identify the issue as an actual Epic.
     */
    if (sourceIssue.title.startsWith(epicPrefix))
        updateEpic(octokit, context, sourceIssue);
    else
        updateTask(octokit, context, sourceIssue);
}

// Update Epic issue
async function updateEpic(octokit, context, issue) {
    console.log("Updating Epic issue '" + issue.title + "'...");
    console.log("  -- Issue number is " + issue.number);
    console.log("  -- Issue body is '" + issue.body + "'");
    // console.log(issue);

    /*
     * Issues forming the workload for this Epic are expected to be in a section
     * of the main issue body called 'Workload', as indicated by a markdown
     * heading ('#', '##', etc.).
     */

    // Split the Epic body into individual lines
    var inWorkload = false
    var body = issue.body.split(/\r?\n/g);
    for (line of body) {
        // Check for heading, potentially indicating the start of the workload section
        if (line.startsWith("#")) {
            if (line.endsWith("Workload")) {
                inWorkload = true;
                continue;
            }
            else if (inWorkload)
                break;
        }

        // If we are not in the workload section, no need to do anything else
        if (!inWorkload)
            continue;

        // Does the line start with checkbox MD, indicating a task?
        console.log("TEST LINE: " + line);
        const matchExpression = /( *)- \[(x| )\] #([0-9+]).*/g;
        var bits = matchExpression.exec(line);
        if (bits) {
            console.log("MATCH:");
            console.log(" -- Full: " + bits[0]);
            console.log(" -- Pre : [" + bits[1] + "]");
            console.log(" -- Check : [" + bits[2] + "]");
            console.log(" -- Number : [" + bits[3] + "]");
        }
    }
}

// Update Task issue
async function updateTask(octokit, context, taskIssue) {
    console.log("Updating task issue '" + taskIssue.title + "'...");
    console.log("  -- Issue number is " + taskIssue.number);
    console.log("  -- Issue body is '" + taskIssue.body + "'");
    console.log(taskIssue);

    /*
     * Normal issues may or may not be associated to an Epic. If they are not,
     * there is nothing more to do. If they are, then we must update the Epic
     * accordingly.
     */
    const timeline = await octokit.issues.listEventsForTimeline({
        ...context.repo,
        issue_number: taskIssue.number
    });
    console.log(timeline);
    // Look for 'cross-referenced' events, and check if those relate to Epics
    for (event of timeline.data) {
        if (event.event != "cross-referenced") continue;
        console.log("FOUND A CROSS-REFERENCED TIMELINE EVENT:");
        console.log(event.source);

        // Get the referencing issue number from the 'source' data
//         const refIssue = await octokit.issues.get({
//             ...context.repo,
//             issue_number: event.source.number
//         });
    }
}

// Run the action
run()

