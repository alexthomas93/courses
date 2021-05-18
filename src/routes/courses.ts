import path from 'path'
import { Router } from 'express'
import { requiresAuth } from 'express-openid-connect'
import { enrolInCourse } from '../domain/services/enrol-in-course'
import { getCourseWithProgress } from '../domain/services/get-course-with-progress'
import { verifyCodeChallenge } from '../domain/services/verify-code-challenge'
import { getCourses } from '../domain/services/get-courses.service'
import { getToken, getUser } from '../middleware/auth'
import { createSandbox, getSandboxForUseCase } from '../modules/sandbox'
import { convertCourseOverview, convertLessonOverview, convertModuleOverview } from '../modules/asciidoc'
import NotFoundError from '../errors/not-found.error'
import { saveLessonProgress } from '../domain/services/save-lesson-progress'
import { Answer } from '../domain/model/answer'
import { markAsRead } from '../domain/services/mark-as-read'

const router = Router()

/**
 * @GET /
 *
 * Display a list of available courses
 */
router.get('/', (req, res, next) => {
    getCourses()
        .then(courses => res.render('home', { courses }))
        .catch(e => next(e))
})

/**
 * @GET /:course
 *
 * Render course information from overview.adoc in the course root
 */
router.get('/:course', async (req, res, next) => {
    try {
        const user = await getUser(req)

        // TODO: Flash memory
        const interested = req.query.interested

        // TODO: Get next link for "Continue Lesson" button
        const course = await getCourseWithProgress(req.params.course, user)

        const doc = await convertCourseOverview(course.slug)

        res.render('course/overview', {
            classes: `course ${course.slug}`,
            ...course,
            doc,
            interested,
        })
    }
    catch (e) {
        next(e)
    }

})

/**
 * @GET /:course/badge
 *
 * Find and send the badge.svg file in the course root
 */
router.get('/:course/badge', (req, res, next) => {
    res.sendFile(path.join(__dirname, '..', '..', 'asciidoc', 'courses', req.params.course, 'badge.svg'))
})


/**
 * @GET /:course/enrol
 *
 * Create an :Enrolment node between the user and the course within the database
 */
router.get('/:course/enrol', requiresAuth(), async (req, res, next) => {
    try {
        const user = await getUser(req)
        const token = await getToken(req)

        const enrolment = await enrolInCourse(req.params.course, user!)

        if (enrolment.course.usecase) {
            try {
            await createSandbox(token, enrolment.course.usecase)
            }
            catch(e) {
                console.log('error creating sandbox', e);

            }
        }

        const goTo = enrolment.nextModule?.link || `/courses/${enrolment.course.slug}/`

        res.redirect(goTo)
    }
    catch (e) {
        next(e)
    }
})

/**
 * @GET /:course/browser
 *
 * Pre-fill the login credentials into local storage and then redirect to the
 * patched version of browser hosted at /browser/
 */
router.get('/:course/browser', requiresAuth(), async (req, res, next) => {
    try {
        const token = await getToken(req)
        const user = await getUser(req)

        // Check that user is enrolled
        const course = await getCourseWithProgress(req.params.course, user)

        // If not enrolled, send to course home
        if (course.enrolled === false) {
            return res.redirect(`/courses/${req.params.course}`)
        }

        // Check that a use case exists
        // TODO: Specific 404
        if (!course.usecase) {
            return next(new NotFoundError(`No use case for ${req.params.course}`))
        }

        // Check that the user has created a sandbox
        let sandbox = await getSandboxForUseCase(token, course.usecase as string)

        // If sandbox doesn't exist then recreate it
        if (!sandbox) {
            sandbox = await createSandbox(token, course.usecase!)
        }

        // Pre-fill credentials and redirect to browser
        res.render('browser', {
            classes: `course ${req.params.course}`,
            layout: 'empty',
            scheme: sandbox!.scheme,
            host: sandbox!.host,
            port: sandbox!.boltPort,
            username: 'neo4j',
            password: sandbox!.password
        })
    }
    catch (e) {
        next(e)
    }
})


/**
 * @GET /:course/:module
 *
 * If none of the routes matched above, this URL must be a module page.
 * Render index.adoc in the course root
 */
router.get('/:course/:module', async (req, res, next) => {
    try {
        const user = await getUser(req)
        const course = await getCourseWithProgress(req.params.course, user)

        const module = course.modules.find(module => module.slug === req.params.module)

        if (module === undefined) {
            next(new NotFoundError(`Could not find module ${req.params.module} of ${req.params.course}`))
        }

        console.log(module);


        const doc = await convertModuleOverview(req.params.course, req.params.module)

        res.render('course/module', {
            classes: `module ${req.params.course}-${req.params.module}`,
            ...module,
            path: req.originalUrl,
            course,
            doc,
        })
    }
    catch (e) {
        next(e)
    }
})

/**
 * @GET /:course/:module/:lesson
 *
 * Render a lesson, plus any quiz or challenges and the sandbox if necessary
 */
router.get('/:course/:module/:lesson', requiresAuth(), async (req, res, next) => {
    try {
        const user = await getUser(req)
        const course = await getCourseWithProgress(req.params.course, user)

        const module = course.modules.find(module => module.slug === req.params.module)

        if (module === undefined) {
            next(new NotFoundError(`Could not find module ${req.params.module} of ${req.params.course}`))
        }

        const lesson = module!.lessons.find(lesson => lesson.slug === req.params.lesson)

        if (lesson === undefined) {
            next(new NotFoundError(`Could not find lesson ${req.params.lesson} in module ${req.params.module} of ${req.params.course}`))
        }

        const doc = await convertLessonOverview(req.params.course, req.params.module, req.params.lesson, {
            'name': user!.given_name,
        })

        res.render('course/lesson', {
            classes: `lesson ${req.params.course}-${req.params.module}-${req.params.lesson} ${lesson!.completed ? 'lesson--completed' : ''}`,
            ...lesson,
            path: req.originalUrl,
            course,
            module,
            doc,
        })
    }
    catch (e) {
        next(e)
    }
})

/**
 * @POST /:course/:module/:lesson
 *
 * Save the answers that the user has given and mark the module as complete if necessary
 *
 * TODO: Improve internal checking that quiz has been passed
 */
router.post('/:course/:module/:lesson', requiresAuth(), async (req, res, next) => {
    try {
        const { course, module, lesson } = req.params
        const answers: Answer[] = req.body

        const user = await getUser(req)
        const output = await saveLessonProgress(user!, course, module, lesson, answers)

        res.json(output)
    }
    catch (e) {
        next(e)
    }
})

/**
 * @GET /:course/:module/:lesson/verify
 *
 * Verify that the challenge has been completed in the database.
 * This method takes the ':verify:' page attribute from the lesson file and
 * runs it against the database.  The query should return a single row with an
 * outcome column - which should return true or false
 */
router.post('/:course/:module/:lesson/verify', requiresAuth(), async (req, res, next) => {
    try {
        const { course, module, lesson } = req.params
        const user = await getUser(req)
        const token = await getToken(req)

        const outcome = await verifyCodeChallenge(user!, token, course, module, lesson)

        res.json(outcome)
    }
    catch (e) {
        next(e)
    }
})

/**
 * @GET /:course/:module/:lesson/read
 *
 * Mark a text-only page as completed
 *
 * input::read[type=button,class=btn,value=Mark as Read]
 *
 */
router.post('/:course/:module/:lesson/read', requiresAuth(), async (req, res, next) => {
    try {
        const { course, module, lesson } = req.params
        const user = await getUser(req)

        const outcome = await markAsRead(user!, course, module, lesson)

        res.json(outcome)
    }
    catch (e) {
        next(e)
    }
})

export default router