const github = require("@actions/github");
const core = require("@actions/core");

// Get configuration variables
const secretToken = core.getInput("secret-token");
const epicPrefix = core.getInput("epic-prefix");
const tasksMarker = core.getInput("tasks-marker");
const closeCompletedEpics = core.getInput("close-completed-epics");

// Constants
const taskExpression = /(?<pre> *)- \[(?<closed>.)\] #(?<number>[0-9]+) *(?<title>.*)/;

// Construct Octokit object and get GitHub context
const octokit = new github.getOctokit(secretToken);
const context = github.context;

// Main function
async function run() {
    // Safety check - only act on issues
    var sourceIssue = context.payload.issue;
    if (!sourceIssue)
        return;

    // Print config
    console.log("Config:")
    console.log("  - epicPrefix = '" + epicPrefix + "'");
    console.log("  - tasksMarker = '" + tasksMarker + "'");
    console.log("  - closeCompletedEpics = " + closeCompletedEpics);

    // Check config
    if (epicPrefix === "") {
        core.setFailed("Epic prefix cannot be an empty string.");
        return;
    }
    if (tasksMarker === "") {
        core.setFailed("Workload marker cannot be an empty string.");
        return;
    }

    /*
     * The issue may be an Epic that has been created / updated, in which case we
     * reformat the 'Workload' section to include issue titles etc.
     *
     * It may also be a normal issue that is referenced within an Epic - in that
     * case we just update the corresponding entry in the 'Workload' section,
     * marking the task as complete, updating its title, etc.
     *
     * Check the issue title to find out which is the case, using 'epicPrefix' to
     * identify the issue as an actual Epic.
     */

    var result = null;
    if (sourceIssue.title.startsWith(epicPrefix)) {
        try {
            result = await updateEpic(sourceIssue);
        } catch(err) {
            core.setFailed(err);
            return;
        }
    }
    else {
        try {
            result = await updateEpicFromTask(sourceIssue);
        } catch(err) {
            core.setFailed(err);
            return;
        }
    }

    console.log(result);
}

// Update Epic issue
async function updateEpic(epicIssue) {
    console.log("Updating Epic issue #" + epicIssue.number + " (" + epicIssue.title + ")...");

    /*
     * Issues forming the workload for this Epic are expected to be in a section
     * of the main issue body called 'Workload', as indicated by a markdown
     * heading ('#', '##', etc.).
     */

    // Split the Epic body into individual lines
    var inWorkload = false
    var body = epicIssue.body.split(/\r?\n/g);
    var nBodyLines = body.length;
    for (var i = 0; i < nBodyLines; ++i) {
        // Check for heading, potentially indicating the start of the workload section
        if (body[i].startsWith("#")) {
            if (body[i].endsWith(tasksMarker)) {
                inWorkload = true;
                continue;
            }
            else if (inWorkload)
                break;
        }

        // If we are not in the workload section, no need to do anything else
        if (!inWorkload)
            continue;

        // Does the line start with checkbox markdown indicating a task?
        let match = taskExpression.exec(body[i]);
        if (match == null)
            continue;

        // Retrieve task issue
        var taskIssue = null;
        try {
            taskIssue = await octokit.issues.get({
                ...context.repo,
                issue_number: parseInt(match.groups.number)
            });
        } catch(err) {
            core.setFailed(err);
            return false;
        }

        // Did we find the issue?
        if (!taskIssue) {
            core.setFailed("Error - task #" + match.groups.number + " is referenced in Epic #" + epicIssue.number + " but it doesn't exist.");
            return false;
        }

        // Update the Epic issue body based on the task issue data if it needs it
        var result = null;
        try {
            result = await updateTask(epicIssue.number, body[i], taskIssue.data, false);
        } catch(err) {
            core.setFailed(err);
            return;
        }
        if (!result) {
            console.log("Nothing to update for task #" + taskIssue.data.number + " in Epic #" + epicIssue.number + ".");
            continue;
        }

        // Store the updated line in our body array
        body[i] = result.line;

        // Comment on the Epic?
        if (result.comment) {
            try {
                await octokit.issues.createComment({
                    ...context.repo,
                    issue_number: epicIssue.number,
                    body: result.comment
                });
            } catch(err) {
                core.setFailed(err);
                return false;
            }
        }

        console.log("Updated Epic #" + epicIssue.number + " with new information for task #" + taskIssue.data.number);
    }

    // Commit the updated Epic body text
    var newBody = body.join("\r\n");
    try {
        await octokit.issues.update({
            ...context.repo,
            issue_number: epicIssue.number,
            body: newBody
        });
    } catch(err) {
        core.setFailed(err);
        return false;
    }

    // Close the Epic if all tasks are completed?
    if (closeCompletedEpics)
        await closeEpicIfComplete(epicIssue.number, newBody);

    return true;
}

// Update Task issue within Epic
async function updateEpicFromTask(taskIssue) {
    console.log("Searching issue #" + taskIssue.number + " (" + taskIssue.title + ") for Epic cross-references...");

    /*
     * Normal issues may or may not be associated to an Epic. If they are not,
     * there is nothing more to do. If they are, then we must update the Epic
     * accordingly.
     *
     * The task may be present in more than one Epic, so consider all referenced
     * issues.
     */
    var timeline = null;
    try {
        timeline = await octokit.issues.listEventsForTimeline({
            ...context.repo,
            issue_number: taskIssue.number
        });
    } catch(err) {
        core.setFailed(err);
        return false;
    }

    // Look for 'cross-referenced' events, and check if those relate to Epics
    for (event of timeline.data) {
        if (event.event != "cross-referenced")
            continue;

        // If the cross-referencing event is not an issue, continue
        if (event.source.type != "issue")
            continue;

        // Get referencing Epic issue
        const epicIssue = event.source.issue;

        // Is the cross-referencing issue an Epic?
        if (!epicIssue.title.startsWith(epicPrefix))
            continue;
        console.log("Task issue #" + taskIssue.number + " is cross-referenced by Epic #" + epicIssue.number);

        // Update the Epic issue body based on our own data if necessary
        var result = null;
        try {
            result = await updateTaskInEpic(epicIssue.number, epicIssue.body, taskIssue);
        } catch(err) {
            core.setFailed(err);
            return;
        }
        if (!result) {
            console.log("Nothing to update - Epic #" + epicIssue.number + " body remains as-is.");
            return false;
        }

        // Commit the updated Epic
        try {
            await octokit.issues.update({
                ...context.repo,
                issue_number: epicIssue.number,
                body: result.body
            });
        } catch(err) {
            core.setFailed(err);
            return false;
        }

        // Comment on the Epic?
        if (result.comment) {
            try {
                await octokit.issues.createComment({
                    ...context.repo,
                    issue_number: epicIssue.number,
                    body: result.comment
                });
            } catch(err) {
                core.setFailed(err);
                return false;
            }
        }

        console.log("Updated Epic #" + epicIssue.number + " with new information for task #" + taskIssue.number);

        // Close the Epic if all tasks are completed?
        if (closeCompletedEpics)
            await closeEpicIfComplete(epicIssue.number, result.body);
    }

    return true;
}

// Update task within supplied body text from issue data given
async function updateTaskInEpic(epicNumber, epicBody, taskIssue) {
    var inWorkload = false
    var body = epicBody.split(/\r?\n/g);
    var nBodyLines = body.length;
    for (var i = 0; i < nBodyLines; ++i) {
        // Check for heading, potentially indicating the start of the workload section
        if (body[i].startsWith("#")) {
            if (body[i].endsWith(tasksMarker)) {
                inWorkload = true;
                continue;
            }
            else if (inWorkload)
                return null;
        }

        // If we are not in the workload section, no need to do anything else
        if (!inWorkload)
            continue;

        // Does the line start with checkbox markdown indicating a task?
        var match = taskExpression.exec(body[i]);
        if (!match)
            continue;

        // Does the taskIssue number match the one on this line?
        if (match.groups.number != taskIssue.number)
            continue;

        // Found the taskIssue in the list, so update as necessary
        var result = null;
        try {
            result = await updateTask(epicNumber, body[i], taskIssue, true);
        } catch(err) {
            core.setFailed(err);
            return;
        }
        if (!result)
            return null;

        // Reconstitute and return updated body text
        body[i] = result.line;
        return {
            body: body.join("\r\n"),
            comment: result.comment
        }
    }

    return null;
}

// Update task data, returning new line and comment if changes were made, or null if it was up to date
async function updateTask(epicNumber, taskLine, taskIssue, taskIsTruth) {
    // Ensure that we're working with a task line
    var match = taskExpression.exec(taskLine);
    if (!match) {
        console.log("...updateTask() - Not a task line? (\""+taskLine+"\")");
        return null;
    }

    // Does the taskIssue number match the one on this line?
    if (match.groups.number != taskIssue.number) {
        console.log("...updateTask() - Issue numbers don't match (" + match.groups.number + " vs. " + taskIssue.number + ")");
        return null;
    }

    // Check task status and title and update as necessary
    var updateTitle = false;
    var updateState = false;
    const epicIssueClosed = match.groups.closed === "x";
    const taskIssueClosed = taskIssue.state === "closed";
    if (epicIssueClosed != taskIssueClosed)
        updateState = true;
    if (match.groups.title != taskIssue.title)
        updateTitle = true;

    // Return null if no updates were necessary
    if (!updateTitle && !updateState)
        return null;

    var newLine = null;
    var comment = null;

    // If the current task state in the issue is truth (taskIsTruth === true) then we update the (Epic) line from the issue.
    // Otherwise, we update the issue from the (Epic) line.
    if (taskIsTruth) {
        // Reconstitute the line, create a suitable comment, and return the new data
        newLine = match.groups.pre + "- [" + (taskIssueClosed ? "x" : " ") + "] #" + taskIssue.number + " " + taskIssue.title;

        if (updateState && updateTitle)
            comment = "`EpicBot` refreshed the title for task #" + taskIssue.number + " and marked it as `" + (taskIssueClosed ? "closed" : "open") + "`.";
        else if (updateState)
            comment = "`EpicBot` marked task #" + taskIssue.number + " as `" + (taskIssueClosed ? "closed" : "open") + "`.";
        else if (updateTitle)
            comment = "`EpicBot` refreshed the title for task #" + taskIssue.number + ".";
    }
    else
    {
        // Update the issue state from the current data, if it is required
        if (updateState) {
            // The line remains the same, but we will update the issue accordingly
            try {
                await octokit.issues.update({
                    ...context.repo,
                    issue_number: taskIssue.number,
                    state: epicIssueClosed ? "closed" : "open"
                });
            } catch(err) {
                core.setFailed(err);
                return false;
            }

            // Comment on the issue
            try {
                await octokit.issues.createComment({
                    ...context.repo,
                    issue_number: taskIssue.number,
                    body: "`EpicBot` " + (epicIssueClosed ? "closed" : "re-opened") + " this issue following changes in Epic #" + epicNumber + "."
                });
            } catch(err) {
                core.setFailed(err);
                return false;
            }
        }

        // Reconstitute the line, and generate a suitable comment
        newLine = match.groups.pre + "- [" + (epicIssueClosed ? "x" : " ") + "] #" + taskIssue.number + " " + taskIssue.title;
        if (updateState && updateTitle)
            comment = "`EpicBot` " + (epicIssueClosed ? "closed" : "opened") + " task #" + taskIssue.number + " following changes in the Epic, and refreshed its title.";
        else if (updateState)
            "`EpicBot` " + (epicIssueClosed ? "closed" : "opened") + " task #" + taskIssue.number + " following changes in the Epic."
        else if (updateTitle)
            comment = "`EpicBot` refreshed the title for task #" + taskIssue.number + ".";
    }

    // Return updated data
    return {
        line: newLine,
        comment: comment
    }
}

// Close specifed Epic if all tasks (in the associated body) are complete
async function closeEpicIfComplete(epicNumber, epicBody) {
    console.log("Checking if Epic #" + epicNumber + "  is complete...");
    var inWorkload = false;
    var nTasks = 0;
    var body = epicBody.split(/\r?\n/g);
    for (line of body) {
        // Check for heading, potentially indicating the start of the workload section
        if (line.startsWith("#")) {
            if (line.endsWith(tasksMarker)) {
                inWorkload = true;
                continue;
            }
            else if (inWorkload)
                break;
        }

        // If we are not in the workload section, continue
        if (!inWorkload)
            continue;

        // Does the line start with checkbox markdown indicating a task?
        let match = taskExpression.exec(line);
        if (match == null)
            continue;

        ++nTasks;

        // If the task is not complete, return false immediately
        if (match.groups.closed != "x")
            return false;
    }

    // Exit here if there are no tasks associated to this epic
    if (nTasks == 0)
	return false;

    console.log("Closing Epic #" + epicNumber + " as all tasks have been completed.");
    try {
        await octokit.issues.createComment({
            ...context.repo,
            issue_number: epicNumber,
            body: "`EpicBot` closed this Epic as all tasks are complete."
        });
    } catch(err) {
        core.setFailed(err);
        return false;
    }
    try {
        await octokit.issues.update({
            ...context.repo,
            issue_number: epicNumber,
            state: "closed"
        });
    } catch(err) {
        core.setFailed(err);
        return false;
    }

    return true;
}

// Run the action
run()
