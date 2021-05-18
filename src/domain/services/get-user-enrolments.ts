import { convertCourseOverview } from "../../modules/asciidoc";
import { read } from "../../modules/neo4j";
import { sortCourse } from "../../utils";
import { CourseWithProgress } from "../model/course";
import { EnrolmentsByStatus, STATUS_AVAILABLE, STATUS_COMPLETED, STATUS_ENROLLED } from "../model/enrolment";
import { Module } from "../model/module";

export async function getUserEnrolments(id: string): Promise<EnrolmentsByStatus> {

    const res = await read(`
        MATCH (u:User {id: $id})
        MATCH (c:Course)

        OPTIONAL MATCH (u)-[:HAS_ENROLMENT]->(e)-[:FOR_COURSE]->(c)

        WITH
            u { .id, .name, .givenName } AS user,

            c {
                .*,
                createdAt: e.createdAt,
                completed: e:CompletedEnrolment,
                completedAt: e.completedAt,
                modules: [ (c)-[:HAS_MODULE]->(m) | m {
                    .*,
                    link: '/courses/'+ c.slug +'/'+ m.slug,
                    completed: exists((e)-[:COMPLETED_MODULE]->(m)),
                    lessons: [ (m)-[:HAS_LESSON]->(l) | l {
                        .*,
                        completed: exists((e)-[:COMPLETED_LESSON]->(l)),
                        link: '/courses/'+ c.slug +'/'+ m.slug +'/'+ l.slug,
                        previous: [ (l)<-[:NEXT_LESSON]-(prev)<-[:HAS_LESSON]-(pm) | prev { .slug, .title, link: '/courses/'+ c.slug + '/'+ pm.slug +'/'+ prev.slug} ][0],
                        next: [ (l)-[:NEXT_LESSON]->(next)<-[:HAS_LESSON]-(nm) | next { .slug, .title, link: '/courses/'+ c.slug + '/'+ nm.slug +'/'+ next.slug } ][0],
                        questions: [(l)-[:HAS_QUESTION]->(q) | q { .id, .slug }]
                    } ]
                } ]
            } AS course,
            CASE WHEN e IS NULL THEN '${STATUS_AVAILABLE}'
                 WHEN e:CompletedEnrolment THEN '${STATUS_COMPLETED}'
                 ELSE '${STATUS_ENROLLED}'
            END as status

        WITH user, status, collect(course) AS courses

        WITH user, collect([status, courses]) AS pairs

        RETURN user, apoc.map.fromPairs(pairs) AS enrolments
    `, { id })

    if ( res.records.length === 0 ) {
        return <EnrolmentsByStatus> {}
    }

    const user = res.records[0].get('user')
    const enrolments = res.records[0].get('enrolments')

    // Sort items because we can't do this in a pattern comprehension
    for (let key in enrolments) {
        for (let course of enrolments[key]) {
            sortCourse(course)
        }
    }

    return {
        user,
        enrolments,
    }

}