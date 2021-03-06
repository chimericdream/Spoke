import { r, User } from "src/server/models";
import { cacheableData } from "src/server/models/cacheable_queries";
import db from "src/server/db";
import { mapFieldsToModel } from "./lib/utils";

const firstName = '"user"."first_name"';
const lastName = '"user"."last_name"';
const created = '"user"."created_at"';
const oldest = created;
const newest = '"user"."created_at" desc';

const lower = column => `lower(${column})`;

function buildSelect(sortBy) {
  const userStar = '"user".*';

  let fragmentArray = undefined;

  switch (sortBy) {
    case "COUNT_ONLY":
      return r.knex.countDistinct("user.id");
    case "LAST_NAME":
      fragmentArray = [userStar, lower(lastName), lower(firstName)];
      break;
    case "NEWEST":
      fragmentArray = [userStar];
      break;
    case "OLDEST":
      fragmentArray = [userStar];
      break;
    case "FIRST_NAME":
    default:
      fragmentArray = [userStar, lower(lastName), lower(firstName)];
      break;
  }

  return r.knex.select(r.knex.raw(fragmentArray.join(", ")));
}

function buildOrderBy(query, sortBy) {
  let fragmentArray = undefined;

  switch (sortBy) {
    case "COUNT_ONLY":
      return query;
    case "LAST_NAME":
      fragmentArray = [lower(lastName), lower(firstName), newest];
      break;
    case "NEWEST":
      fragmentArray = [newest];
      break;
    case "OLDEST":
      fragmentArray = [oldest];
      break;
    case "FIRST_NAME":
    default:
      fragmentArray = [lower(firstName), lower(lastName), newest];
      break;
  }

  return query.orderByRaw(fragmentArray.join(", "));
}

const addLeftOuterJoin = query =>
  query.leftOuterJoin("assignment", "assignment.user_id", "user.id");
export function buildUserOrganizationQuery(
  queryParam,
  organizationId,
  role,
  campaignsFilter,
  filterString,
  filterBy
) {
  const roleFilter = role ? { role } : {};

  let query = queryParam
    .from("user_organization")
    .innerJoin("user", "user_organization.user_id", "user.id")
    .where(roleFilter)
    .whereRaw('"user_organization"."organization_id" = ?', organizationId)
    .distinct();

  if (filterString) {
    const filterStringWithPercents = (
      "%" +
      filterString +
      "%"
    ).toLocaleLowerCase();

    if (filterBy === "FIRST_NAME") {
      query = query.andWhere(
        r.knex.raw("first_name ILIKE ?", [filterStringWithPercents])
      );
    } else if (filterBy === "LAST_NAME") {
      query = query.andWhere(
        r.knex.raw("last_name ILIKE ?", [filterStringWithPercents])
      );
    } else if (filterBy === "EMAIL") {
      query = query.andWhere(
        r.knex.raw("email ILIKE ?", [filterStringWithPercents])
      );
    } else {
      query = query.andWhere(
        r.knex.raw("first_name ILIKE ? OR last_name ILIKE ? OR email ILIKE ?", [
          filterStringWithPercents,
          filterStringWithPercents,
          filterStringWithPercents
        ])
      );
    }
  }

  if (campaignsFilter) {
    if (campaignsFilter.campaignId) {
      query = addLeftOuterJoin(query);
      query = query.where({
        "assignment.campaign_id": campaignsFilter.campaignId
      });
    } else if (
      campaignsFilter.campaignIds &&
      campaignsFilter.campaignIds.length > 0
    ) {
      const questionMarks = Array(campaignsFilter.campaignIds.length)
        .fill("?")
        .join(",");
      query = addLeftOuterJoin(query);
      query = query.whereRaw(
        `"assignment"."campaign_id" in (${questionMarks})`,
        campaignsFilter.campaignIds
      );
    }
  }

  return query;
}

export function buildSortedUserOrganizationQuery(
  organizationId,
  role,
  campaignsFilter,
  sortBy,
  filterString,
  filterBy
) {
  const query = buildUserOrganizationQuery(
    buildSelect(sortBy),
    organizationId,
    role,
    campaignsFilter,
    filterString,
    filterBy
  );
  return buildOrderBy(query, sortBy);
}

function buildUsersQuery(
  organizationId,
  campaignsFilter,
  role,
  sortBy,
  filterString,
  filterBy
) {
  return buildSortedUserOrganizationQuery(
    organizationId,
    role,
    campaignsFilter,
    sortBy,
    filterString,
    filterBy
  );
}

export async function getUsers(
  organizationId,
  cursor,
  campaignsFilter,
  role,
  sortBy,
  filterString,
  filterBy
) {
  let usersQuery = buildUsersQuery(
    organizationId,
    campaignsFilter,
    role,
    sortBy,
    filterString,
    filterBy
  );

  if (cursor) {
    usersQuery = usersQuery.limit(cursor.limit).offset(cursor.offset);
    const users = await usersQuery;

    const usersCountQuery = buildUsersQuery(
      organizationId,
      campaignsFilter,
      role,
      "COUNT_ONLY"
    );

    const usersCountArray = await usersCountQuery;

    const pageInfo = {
      limit: cursor.limit,
      offset: cursor.offset,
      total: usersCountArray[0].count
    };

    return {
      users,
      pageInfo
    };
  } else {
    return usersQuery;
  }
}

export const resolvers = {
  UsersReturn: {
    __resolveType(obj) {
      if (Array.isArray(obj)) {
        return "UsersList";
      } else if ("users" in obj && "pageInfo" in obj) {
        return "PaginatedUsers";
      }
      return null;
    }
  },
  UsersList: {
    users: users => users
  },
  PaginatedUsers: {
    users: queryResult => queryResult.users,
    pageInfo: queryResult => {
      if ("pageInfo" in queryResult) {
        return queryResult.pageInfo;
      }
      return null;
    }
  },
  User: {
    ...mapFieldsToModel(
      ["id", "firstName", "lastName", "email", "cell", "assignedCell", "terms"],
      User
    ),
    displayName: user => `${user.first_name} ${user.last_name}`,
    assignment: async (user, { campaignId }) => {
      if (
        user.assignment_id &&
        user.assignment_campaign_id === Number(campaignId)
      ) {
        // from context of campaign.texters.assignment
        return {
          id: user.assignment_id,
          campaign_id: user.assignment_campaign_id,
          max_contacts: user.assignment_max_contacts
        };
      }
      return r
        .table("assignment")
        .getAll(user.id, { index: "user_id" })
        .filter({ campaign_id: campaignId })
        .limit(1)(0)
        .default(null);
    },
    organizations: async (user, { role }) => {
      if (!user || !user.id) {
        return [];
      }
      // Note: this only returns {id, name}, but that is all apis need here
      return await cacheableData.user.userOrgs(user.id, role);
    },
    roles: async (user, { organizationId }) =>
      cacheableData.user.orgRoles(user.id, organizationId),
    allRoles: async user => cacheableData.user.allRoles(user.id),
    assignmentSummaries: async (user, { organizationId }) => {
      // snake_case assignments to pass them to the resolver while camelCasing
      // counts to return them using the default resolver :(
      const assignments = await db.Assignment.listActiveAssignmentsForUser(
        { userId: user.id, organizationId },
        { snakeCase: true }
      );
      const summaries = await db.Assignment.countsByStatus(
        assignments.map(a => a.id)
      );
      return assignments.map(assignment => ({
        assignment,
        contactCounts: summaries[assignment.id] || []
      }));
    },

    subscribedToReminders: user =>
      user.subscribed_to_reminders == null ? true : user.subscribed_to_reminders
  }
};
